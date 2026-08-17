import { v } from "convex/values";
import { action, internalQuery, mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { VapiClient } from "@vapi-ai/server-sdk";

// Helper to get current user
async function getCurrentUser(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return null;
  }

  const possibleIdentifiers: string[] = [];
  if (identity.tokenIdentifier) {
    const parts = identity.tokenIdentifier.split("|");
    if (parts.length > 1) {
      possibleIdentifiers.push(parts[1]);
    }
  }
  if (identity.subject) {
    possibleIdentifiers.push(identity.subject);
  }

  for (const token of possibleIdentifiers) {
    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", token))
      .unique();
    if (user) {
      return user;
    }
  }

  return null;
}

async function canAccessContact(
  ctx: QueryCtx,
  currentUserId: Id<"users">,
  contactUserId: Id<"users">
) {
  if (currentUserId === contactUserId) {
    return true;
  }

  const [asInitiator, asScanner] = await Promise.all([
    ctx.db
      .query("conversations")
      .withIndex("by_initiator", (q) =>
        q.eq("initiatorUserId", currentUserId)
      )
      .collect(),
    ctx.db
      .query("conversations")
      .withIndex("by_scanner", (q) => q.eq("scannerUserId", currentUserId))
      .collect(),
  ]);

  return [...asInitiator, ...asScanner].some(
    (conversation) =>
      conversation.initiatorUserId === contactUserId ||
      conversation.scannerUserId === contactUserId
  );
}

export const getAuthorizedContact = internalQuery({
  args: { contactUserId: v.id("users") },
  handler: async (ctx, args) => {
    const currentUser = await getCurrentUser(ctx);
    if (!currentUser) {
      return null;
    }

    if (!(await canAccessContact(ctx, currentUser._id, args.contactUserId))) {
      return null;
    }

    const contact = await ctx.db.get(args.contactUserId);
    return contact ? { contact, isSelf: contact._id === currentUser._id } : null;
  },
});

// Update user's phone number
export const updatePhoneNumber = mutation({
  args: {
    userId: v.id("users"),
    phoneNumber: v.string(),
  },
  handler: async (ctx, args) => {
    const currentUser = await getCurrentUser(ctx);
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

// Get user's phone number
export const getPhoneNumber = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const currentUser = await getCurrentUser(ctx);
    if (!currentUser) {
      throw new Error("Not authenticated");
    }

    if (!(await canAccessContact(ctx, currentUser._id, args.userId))) {
      throw new Error("Not authorized to view this phone number");
    }

    const user = await ctx.db.get(args.userId);
    return user?.phoneNumber ?? null;
  },
});

// Initiate VAPI call
export const initiateCall = action({
  args: {
    contactUserId: v.id("users"),
    phoneNumber: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{
    success: boolean;
    callId: string;
    phoneNumber: string;
  }> => {
    if (!(await ctx.auth.getUserIdentity())) {
      throw new Error("Not authenticated");
    }

    const authorizedContact = await ctx.runQuery(
      internal.vapi.getAuthorizedContact,
      { contactUserId: args.contactUserId }
    );

    if (!authorizedContact) {
      throw new Error("Contact not found or not authorized");
    }

    const { contact, isSelf } = authorizedContact;

    // Use provided phone number or get from contact
    const phoneNumber: string | null | undefined = args.phoneNumber || contact.phoneNumber;

    if (!phoneNumber) {
      throw new Error("No phone number available for this contact");
    }

    // Validate phone number format
    const phoneRegex = /^\+1\d{10}$/;
    if (!phoneRegex.test(phoneNumber)) {
      throw new Error("Invalid phone number format. Must be +1XXXXXXXXXX");
    }

    // A caller may not replace another account's phone number merely by
    // supplying it to this action. Contacts must manage their own number.
    if (args.phoneNumber && args.phoneNumber !== contact.phoneNumber) {
      if (!isSelf) {
        throw new Error("The contact must add their own phone number before calling");
      }

      await ctx.runMutation(api.users.updatePhoneNumber, {
        userId: args.contactUserId,
        phoneNumber: args.phoneNumber,
      });
    }

    // Validate environment variables
    if (!process.env.VAPI_API_KEY) {
      throw new Error("VAPI_API_KEY is not configured");
    }
    if (!process.env.VAPI_PHONE_NUMBER_ID) {
      throw new Error("VAPI_PHONE_NUMBER_ID is not configured");
    }
    if (!process.env.VAPI_WORKFLOW_ID) {
      throw new Error("VAPI_WORKFLOW_ID is not configured");
    }

    // Initialize VAPI client
    const vapi = new VapiClient({
      token: process.env.VAPI_API_KEY,
    });

    try {
      // Initiate the call
      const response = await vapi.calls.create({
        phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
        customer: {
          name: contact.name || "Unknown",
          number: phoneNumber,
        },
        workflowId: process.env.VAPI_WORKFLOW_ID,
      });

      // Extract call ID from response
      // VAPI SDK returns different response types, so we handle both
      let callId: string | undefined;

      if (response && typeof response === 'object') {
        callId = (response as any).id || (response as any).callId;
      }

      if (!callId) {
        throw new Error("VAPI did not return a call ID");
      }

      return {
        success: true,
        callId: callId,
        phoneNumber,
      };
    } catch (error: any) {
      console.error("VAPI call error:", error);
      const errorMessage = error.message || "Unknown error occurred";
      throw new Error(`Failed to initiate call: ${errorMessage}`);
    }
  },
});
