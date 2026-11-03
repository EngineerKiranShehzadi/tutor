import { gql } from '@apollo/client';

// The server reads the user id from the auth token, so neither of these takes
// a user argument.

export const MY_NOTIFICATIONS_QUERY = gql`
  query MyNotifications($limit: Int, $offset: Int) {
    myNotifications(limit: $limit, offset: $offset) {
      items {
        id
        type
        title
        body
        lectureId
        read
        createdAt
      }
      total
      unread
      hasMore
    }
  }
`;

// Returns the refreshed first page, so Apollo can update the cache from the
// mutation result without a second request.
export const MARK_NOTIFICATIONS_READ = gql`
  mutation MarkNotificationsRead($ids: [Int!]) {
    markNotificationsRead(ids: $ids) {
      items {
        id
        type
        title
        body
        lectureId
        read
        createdAt
      }
      total
      unread
      hasMore
    }
  }
`;
