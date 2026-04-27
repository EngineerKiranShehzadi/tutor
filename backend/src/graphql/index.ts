import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { Express } from 'express';
import { typeDefs } from './typeDefs';
import { resolvers } from './resolvers/auth.resolver';
import { chatResolvers } from './resolvers/chat.resolver';
import { GraphQLContext } from './context';

const mergedResolvers = {
  Query:    { ...resolvers.Query },
  Mutation: { ...resolvers.Mutation, ...chatResolvers.Mutation },
};

export const setupApollo = async (app: Express): Promise<void> => {
  const server = new ApolloServer<GraphQLContext>({
    typeDefs,
    resolvers: mergedResolvers,
  });

  await server.start();

  app.use(
    '/graphql',
    expressMiddleware(server, {
      context: async ({ req, res }) => ({ req, res }),
    })
  );
};
