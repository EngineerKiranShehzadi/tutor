import { gql } from '@apollo/client';

export const GET_ALL_USERS = gql`
  query AllUsers {
    allUsers {
      id
      name
      email
      role
      isVerified
      createdAt
    }
  }
`;

export const GET_LECTURE_CHUNKS = gql`
  query LectureChunks($lectureId: Int!) {
    lectureChunks(lectureId: $lectureId) {
      id
      topic
      question
      answer
      startTime
      endTime
      keywords
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
    }
  }
`;
