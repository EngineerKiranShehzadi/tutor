import { ApolloClient, InMemoryCache, createHttpLink, fromPromise } from '@apollo/client';
import { setContext } from '@apollo/client/link/context';
import { onError } from '@apollo/client/link/error';

const httpLink = createHttpLink({
  uri: `${process.env.NEXT_PUBLIC_API_URL?.replace('/api/v1', '')}/graphql`,
  credentials: 'include',
});

const authLink = setContext((_, { headers }) => {
  const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
  return {
    headers: {
      ...headers,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  };
});

// Silently refresh the access token using the httpOnly refresh-token cookie
async function refreshAccessToken(): Promise<string | null> {
  try {
    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? '';
    const res = await fetch(`${apiBase}/auth/refresh-token`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) return null;
    const json = await res.json();
    const newToken: string | undefined = json?.data?.accessToken;
    if (newToken) {
      localStorage.setItem('accessToken', newToken);
      return newToken;
    }
    return null;
  } catch {
    return null;
  }
}

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
