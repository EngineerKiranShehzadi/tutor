import { useMutation, ApolloError } from '@apollo/client';
import { SIGNUP_MUTATION } from '@/graphql/auth.mutations';

const getGraphQLErrorMessage = (error: ApolloError): string => {
  if (error.graphQLErrors.length > 0) return error.graphQLErrors[0].message;
  if (error.networkError) return 'Network error. Please check your connection.';
  return error.message;
};

export const useSignup = () => {
  const [mutate, { loading }] = useMutation(SIGNUP_MUTATION);

  const mutateAsync = async (name: string, email: string, password: string) => {
    const result = await mutate({ variables: { input: { name, email, password } } });
    return result.data?.signup as { email: string; message: string };
  };

  return { mutateAsync, isLoading: loading, getErrorMessage: getGraphQLErrorMessage };
};
