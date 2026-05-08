import { gql } from '@apollo/client';

export const DELETE_USER_MUTATION = gql`
  mutation DeleteUser($id: String!) {
    deleteUser(id: $id)
  }
`;

export const UPDATE_USER_ROLE_MUTATION = gql`
  mutation UpdateUserRole($id: String!, $role: String!) {
    updateUserRole(id: $id, role: $role) {
      id
      name
      email
      role
      isVerified
      createdAt
    }
  }
`;

export const UPDATE_ADMIN_PROFILE_MUTATION = gql`
  mutation UpdateAdminProfile($name: String, $currentPassword: String, $newPassword: String) {
    updateAdminProfile(name: $name, currentPassword: $currentPassword, newPassword: $newPassword) {
      id
      name
      email
      role
    }
  }
`;
