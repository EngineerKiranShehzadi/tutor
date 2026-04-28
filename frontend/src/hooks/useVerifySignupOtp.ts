import { useMutation, ApolloError } from '@apollo/client';
import { VERIFY_SIGNUP_OTP_MUTATION } from '@/graphql/auth.mutations';
import { UserRole } from '@/types';

const getGraphQLErrorMessage = (error: ApolloError): string => {
  if (error.graphQLErrors.length > 0) return error.graphQLErrors[0].message;
  if (error.networkError) return 'Network error. Please check your connection.';
  return error.message;
};

export const useVerifySignupOtp = () => {
  const [mutate, { loading }] = useMutation(VERIFY_SIGNUP_OTP_MUTATION);

  const mutateAsync = async (email: string, code: string) => {
    const result = await mutate({ variables: { input: { email, code } } });
    return result.data?.verifySignupOtp as {
      accessToken: string;
      user: { id: string; name: string; email: string; role: UserRole };
    };
  };

  return { mutateAsync, isLoading: loading, getErrorMessage: getGraphQLErrorMessage };
};
