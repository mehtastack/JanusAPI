import { buildSchemaFrom, schemaFromIntrospection, type GraphQLSchema } from '../src';

export const SDL = `
"""A person who writes"""
type User {
  id: ID!
  name: String
  email: String @deprecated(reason: "Use contact")
  posts(first: Int = 10): [Post!]!
  role: Role
}
type Post { id: ID! title: String! author: User score: Float }
enum Role { ADMIN EDITOR }
input ArticleInput { title: String! tags: [String!] }
union SearchResult = User | Post
directive @upper on FIELD
type Query {
  user(id: ID!): User
  users(role: Role): [User!]!
  search(term: String!): [SearchResult!]!
}
type Mutation { createArticle(input: ArticleInput!): Post }
`;

export function fixtureSchema(sdl = SDL): GraphQLSchema {
  const r = buildSchemaFrom(sdl);
  if (!r.ok) throw new Error(r.error);
  return schemaFromIntrospection(r.introspection);
}
