import { useMutation, ApolloError } from '@apollo/client';
import { VERIFY_OTP_MUTATION } from '@/graphql/auth.mutations';

const getGraphQLErrorMessage = (error: ApolloError): string => {
  if (error.graphQLErrors.length > 0) return error.graphQLErrors[0].message;
  if (error.networkError) return 'Network error. Please check your connection.';
  return error.message;
};

export const useVerifyOtp = () => {
  const [mutate, { loading }] = useMutation(VERIFY_OTP_MUTATION);

  const mutateAsync = async (email: string, code: string) => {
    const result = await mutate({ variables: { input: { email, code } } });
    return result.data?.verifyOtp;
  };

  return { mutateAsync, isLoading: loading, getErrorMessage: getGraphQLErrorMessage };
};
