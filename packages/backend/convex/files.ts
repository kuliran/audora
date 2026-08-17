import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";

async function getCurrentUser(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return null;
  }

  return await ctx.db
    .query("users")
    .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.subject))
    .unique();
}

async function userOwnsStorageId(
  ctx: QueryCtx,
  userId: Id<"users">,
  storageId: Id<"_storage">
) {
  const [asInitiator, asScanner, importJobs] = await Promise.all([
    ctx.db
      .query("conversations")
      .withIndex("by_initiator", (q) => q.eq("initiatorUserId", userId))
      .collect(),
    ctx.db
      .query("conversations")
      .withIndex("by_scanner", (q) => q.eq("scannerUserId", userId))
      .collect(),
    ctx.db
      .query("importJobs")
      .withIndex("by_import_initiator", (q) => q.eq("initiatorUserId", userId))
      .collect(),
  ]);

  return (
    [...asInitiator, ...asScanner].some(
      (conversation) => conversation.audioStorageId === storageId
    ) || importJobs.some((job) => job.chunkStorageIds.includes(storageId))
  );
}

async function requireStorageAccess(ctx: QueryCtx, storageId: Id<"_storage">) {
  const user = await getCurrentUser(ctx);
  if (!user) {
    throw new Error("Not authenticated");
  }

  if (!(await userOwnsStorageId(ctx, user._id, storageId))) {
    throw new Error("File not found");
  }
}

/**
 * Generates an upload URL for audio files.
 * This is used by the Mac app to upload recordings.
 * Authentication is required. Ownership is established when the storage ID is
 * attached to a conversation or import job owned by the current user.
 */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    if (!(await getCurrentUser(ctx))) {
      throw new Error("Not authenticated");
    }
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Gets a URL for a stored file by its storage ID.
 * Useful for verifying files were uploaded and getting download URLs.
 */
export const getFileUrl = query({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    await requireStorageAccess(ctx, args.storageId);
    return await ctx.storage.getUrl(args.storageId);
  },
});

/**
 * Lists recent file uploads (for debugging/verification).
 * Note: Convex doesn't have a built-in way to list all files,
 * but you can use this to verify a specific file exists.
 */
export const verifyFileExists = query({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    await requireStorageAccess(ctx, args.storageId);
    try {
      const url = await ctx.storage.getUrl(args.storageId);
      return { exists: url !== null, url };
    } catch {
      return { exists: false, url: null };
    }
  },
});
