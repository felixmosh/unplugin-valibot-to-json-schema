import * as v from "valibot";

export const EmailSchema = v.pipe(v.string(),v.email(), v.minLength(5),v.maxLength(50));

export const UserSchema = v.object({
  name: v.pipe(v.string(), v.minLength(2), v.maxLength(50)),
  email: EmailSchema,
  age: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(150))),
  role: v.optional(v.picklist(["admin", "user", "guest"]), "guest"),
});

export const AdminSchema = v.object({
  ...UserSchema.entries,

  role: v.literal("admin")
});

export const PostSchema = v.object({
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  content: v.pipe(v.string(), v.minLength(10)),
  published: v.optional(v.boolean(), false),
  tags: v.optional(v.array(v.string())),
  author: v.omit(UserSchema, ["role"]),
  views: v.optional(v.pipe(v.number(), v.integer(), v.gtValue(0)), 0),
  createdAt: v.optional(v.pipe(v.string(), v.isoDate()),() => new Date().toISOString().split("T")[0])
});
