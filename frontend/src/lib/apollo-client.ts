import { ApolloClient, InMemoryCache, createHttpLink, fromPromise } from '@apollo/client';
import { setContext } from '@apollo/client/link/context';
import { onError } from '@apollo/client/link/error';
import { getAccessToken, refreshAccessToken } from './auth-token';

const httpLink = createHttpLink({
  uri: `${process.env.NEXT_PUBLIC_API_URL?.replace('/api/v1', '')}/graphql`,
  credentials: 'include',
});

const authLink = setContext((_, { headers }) => {
  const token = getAccessToken();
  return {
    headers: {
      ...headers,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  };
});

// Retry once on UNAUTHENTICATED — refresh token then replay the original operation
const errorLink = onError(({ graphQLErrors, operation, forward }) => {
  if (!graphQLErrors) return;
  const isUnauth = graphQLErrors.some(
    (e) => e.extensions?.code === 'UNAUTHENTICATED'
  );
  if (!isUnauth) return;

  return fromPromise(
    refreshAccessToken().then((newToken) => {
      if (!newToken) {
        // Refresh failed — redirect to login
        if (typeof window !== 'undefined') window.location.href = '/login';
        return false;
      }
      // Inject fresh token into the retried request
      operation.setContext(({ headers = {} }: { headers: Record<string, string> }) => ({
        headers: { ...headers, authorization: `Bearer ${newToken}` },
      }));
      return true;
    })
  )
    .filter(Boolean)
    .flatMap(() => forward(operation));
});

export const apolloClient = new ApolloClient({
  link: errorLink.concat(authLink).concat(httpLink),
  cache: new InMemoryCache(),
});
