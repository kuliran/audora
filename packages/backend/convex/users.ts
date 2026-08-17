import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";

async function findCurrentUser(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return null;
  }

  return await ctx.db
    .query("users")
    .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.subject))
    .unique();
}

async function usersShareConversation(
  ctx: QueryCtx,
  currentUserId: Id<"users">,
  otherUserId: Id<"users">
) {
  if (currentUserId === otherUserId) {
    return true;
  }

  const [asInitiator, asScanner] = await Promise.all([
    ctx.db
      .query("conversations")
      .withIndex("by_initiator", (q) => q.eq("initiatorUserId", currentUserId))
      .collect(),
    ctx.db
      .query("conversations")
      .withIndex("by_scanner", (q) => q.eq("scannerUserId", currentUserId))
      .collect(),
  ]);

  return [...asInitiator, ...asScanner].some(
    (conversation) =>
      conversation.initiatorUserId === otherUserId ||
      conversation.scannerUserId === otherUserId
  );
}

type SharedUserProfile = {
  _id: Id<"users">;
  _creationTime: number;
  name?: string;
  email?: string;
  image?: string;
  inviteCode?: string;
};

function userProfile(user: Doc<"users">): SharedUserProfile {
  return {
    _id: user._id,
    _creationTime: user._creationTime,
    ...(user.name ? { name: user.name } : {}),
    ...(user.email ? { email: user.email } : {}),
    ...(user.image ? { image: user.image } : {}),
    ...(user.inviteCode ? { inviteCode: user.inviteCode } : {}),
  };
}

function redactUserForInvite(user: Doc<"users">): SharedUserProfile {
  return {
    _id: user._id,
    _creationTime: user._creationTime,
    ...(user.inviteCode ? { inviteCode: user.inviteCode } : {}),
  };
}

export const get = query({
  args: { id: v.id("users") },
  handler: async (ctx, args) => {
    const requestedUser = await ctx.db.get(args.id);
    if (!requestedUser) {
      return null;
    }

    const currentUser = await findCurrentUser(ctx);
    if (
      !currentUser ||
      !(await usersShareConversation(ctx, currentUser._id, requestedUser._id))
    ) {
      // The unauthenticated join flow only needs the shareable invite code. Keep
      // the document shape stable for existing clients while removing PII.
      return redactUserForInvite(requestedUser);
    }

    return userProfile(requestedUser);
  },
});

export const getCurrentUser = query({
  handler: async (ctx) => {
    return await findCurrentUser(ctx);
  },
});

export const findUserByToken = query({
  args: { tokenIdentifier: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }

    // Never trust the caller-supplied identifier to select another account.
    if (args.tokenIdentifier !== identity.subject) {
      return null;
    }

    return await findCurrentUser(ctx);
  },
});

async function generateUniqueInviteCode(ctx: any): Promise<string> {
  const maxAttempts = 20;
  for (let i = 0; i < maxAttempts; i++) {
    const code = Math.floor(Math.random() * 10000)
      .toString()
      .padStart(4, "0");
    const existing = await ctx.db
      .query("users")
      .withIndex("by_invite_code", (q: any) => q.eq("inviteCode", code))
      .unique();
    if (!existing) {
      return code;
    }
  }
  throw new Error("Failed to generate unique invite code after 20 attempts");
}

export const upsertUser = mutation({
  args: {
    invitedByCode: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();

    if (!identity) {
      throw new Error("Not authenticated");
    }

    const isLocalIdentity =
      identity.issuer === "http://127.0.0.1:5173" &&
      identity.subject === "audora-local-user";
    const identityName =
      identity.name ?? (isLocalIdentity ? "Local User" : undefined);
    const identityEmail =
      identity.email ?? (isLocalIdentity ? "local@audora.invalid" : undefined);

    // Check if user exists
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.subject))
      .unique();

    if (existingUser) {
      // Update if needed
      if (
        existingUser.name !== identityName ||
        existingUser.email !== identityEmail ||
        existingUser.image !== identity.pictureUrl
      ) {
        await ctx.db.patch(existingUser._id, {
          name: identityName,
          email: identityEmail,
          image: identity.pictureUrl,
        });
      }
      return existingUser;
    }

    // Generate unique invite code
    const inviteCode = await generateUniqueInviteCode(ctx);

    // Create new user
    const userId = await ctx.db.insert("users", {
      name: identityName,
      email: identityEmail,
      image: identity.pictureUrl,
      tokenIdentifier: identity.subject,
      inviteCode,
      invitedByCode: args.invitedByCode,
    });

    return await ctx.db.get(userId);
  },
});

export const getUserByInviteCode = query({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_invite_code", (q) => q.eq("inviteCode", args.code))
      .unique();
    // Invite validation is intentionally public, but it must not expose the
    // invited user's account document.
    return user ? { inviteCode: args.code } : null;
  },
});

export const getUsersInvitedBy = query({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const currentUser = await findCurrentUser(ctx);
    if (!currentUser) {
      throw new Error("Not authenticated");
    }

    if (!currentUser.inviteCode || currentUser.inviteCode !== args.code) {
      throw new Error("Not authorized to view these referrals");
    }

    const users = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("invitedByCode"), args.code))
      .collect();
    return users.map((user) => ({
      _id: user._id,
      _creationTime: user._creationTime,
      ...(user.name ? { name: user.name } : {}),
      ...(user.email ? { email: user.email } : {}),
      ...(user.image ? { image: user.image } : {}),
    }));
  },
});

export const updatePhoneNumber = mutation({
  args: {
    userId: v.id("users"),
    phoneNumber: v.string(),
  },
  handler: async (ctx, args) => {
    const currentUser = await findCurrentUser(ctx);
    if (!currentUser) {
      throw new Error("Not authenticated");
    }

    if (currentUser._id !== args.userId) {
      throw new Error("Not authorized to update this phone number");
    }

    // Validate phone number format (US/Canada: +1XXXXXXXXXX)
    const phoneRegex = /^\+1\d{10}$/;
    if (!phoneRegex.test(args.phoneNumber)) {
      throw new Error("Invalid phone number format. Must be +1XXXXXXXXXX");
    }

    await ctx.db.patch(args.userId, {
      phoneNumber: args.phoneNumber,
    });

    return { success: true };
  },
});
