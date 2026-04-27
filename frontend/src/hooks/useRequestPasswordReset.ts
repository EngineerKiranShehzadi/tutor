import { useMutation, ApolloError } from '@apollo/client';
import { REQUEST_PASSWORD_RESET_MUTATION } from '@/graphql/auth.mutations';

const getGraphQLErrorMessage = (error: ApolloError): string => {
  if (error.graphQLErrors.length > 0) return error.graphQLErrors[0].message;
  if (error.networkError) return 'Network error. Please check your connection.';
  return error.message;
};

export const useRequestPasswordReset = () => {
  const [mutate, { loading }] = useMutation(REQUEST_PASSWORD_RESET_MUTATION);

  const mutateAsync = async (email: string) => {
    const result = await mutate({ variables: { input: { email } } });
    return result.data?.requestPasswordReset;
  };

  return { mutateAsync, isLoading: loading, getErrorMessage: getGraphQLErrorMessage };
};
