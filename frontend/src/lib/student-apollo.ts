import { ApolloClient, InMemoryCache, type ApolloLink } from '@apollo/client';
// Reuse transport/auth, never an account's cache. No persistent browser storage.
export function createStudentApolloClient(link: ApolloLink) {
  return new ApolloClient({ link, cache: new InMemoryCache() });
}
