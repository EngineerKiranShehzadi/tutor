import { useMutation, ApolloError } from '@apollo/client';
import { RESEND_SIGNUP_OTP_MUTATION } from '@/graphql/auth.mutations';

const getGraphQLErrorMessage = (error: ApolloError): string => {
  if (error.graphQLErrors.length > 0) return error.graphQLErrors[0].message;
  if (error.networkError) return 'Network error. Please check your connection.';
  return error.message;
};

export const useResendSignupOtp = () => {
  const [mutate, { loading }] = useMutation(RESEND_SIGNUP_OTP_MUTATION);

  const mutateAsync = async (email: string) => {
    const result = await mutate({ variables: { input: { email } } });
    return result.data?.resendSignupOtp;
  };

  return { mutateAsync, isLoading: loading, getErrorMessage: getGraphQLErrorMessage };
};
