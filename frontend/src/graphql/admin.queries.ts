import { gql } from '@apollo/client';

// One page of users, filtered on the server (AD6).
export const GET_ALL_USERS = gql`
  query AllUsers($limit: Int!, $offset: Int!, $search: String, $role: String) {
    allUsers(limit: $limit, offset: $offset, search: $search, role: $role) {
      items {
        id
        name
        email
        role
        isVerified
        createdAt
      }
      total
      hasMore
      totalUsers
      studentCount
      adminCount
    }
  }
`;

// One page of a lecture's Q&A chunks, searched on the server (AD6).
export const GET_LECTURE_CHUNKS = gql`
  query LectureChunks($lectureId: Int!, $limit: Int!, $offset: Int!, $search: String) {
    lectureChunks(lectureId: $lectureId, limit: $limit, offset: $offset, search: $search) {
      items {
        id
        topic
        question
        answer
        startTime
        endTime
        keywords
      }
      total
      hasMore
    }
  }
`;

export const GET_LECTURE_AGENT_DETAILS = gql`
  query LectureAgentDetails {
    lectureAgentDetails {
      id
      title
      status
      chunkCount
      createdAt
      updatedAt
      agentProfileStatus
      chatReady
      notReadyReason
    }
  }
`;
