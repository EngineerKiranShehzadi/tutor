import { useMutation, ApolloError } from '@apollo/client';
import { RESET_PASSWORD_MUTATION } from '@/graphql/auth.mutations';

const getGraphQLErrorMessage = (error: ApolloError): string => {
  if (error.graphQLErrors.length > 0) return error.graphQLErrors[0].message;
  if (error.networkError) return 'Network error. Please check your connection.';
  return error.message;
};

export const useResetPassword = () => {
  const [mutate, { loading }] = useMutation(RESET_PASSWORD_MUTATION);

  const mutateAsync = async (email: string, newPassword: string, confirmPassword: string) => {
    const result = await mutate({
      variables: { input: { email, newPassword, confirmPassword } },
    });
    return result.data?.resetPassword;
  };

  return { mutateAsync, isLoading: loading, getErrorMessage: getGraphQLErrorMessage };
};
