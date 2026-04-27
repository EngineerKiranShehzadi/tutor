import { ApolloClient, InMemoryCache, createHttpLink } from '@apollo/client';

const httpLink = createHttpLink({
  // NEXT_PUBLIC_API_URL is http://localhost:5000/api/v1 — GraphQL lives at the root /graphql
  uri: `${process.env.NEXT_PUBLIC_API_URL?.replace('/api/v1', '')}/graphql`,
  credentials: 'include',
});

export const apolloClient = new ApolloClient({
  link: httpLink,
  cache: new InMemoryCache(),
});
