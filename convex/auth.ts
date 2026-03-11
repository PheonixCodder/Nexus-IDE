import { MutationCtx, QueryCtx } from "./_generated/server";

export const verifyAuth = async (ctx: QueryCtx | MutationCtx) => {
  const identity = await ctx.auth.getUserIdentity();
  console.log(identity?.name);

  if (!identity) {
    throw new Error("Unauthorized");
  }

  return identity;
};
