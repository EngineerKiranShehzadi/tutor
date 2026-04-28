import { gql } from '@apollo/client';

export const ASK_LECTURE_AGENT_MUTATION = gql`
  mutation AskLectureAgent($input: AskLectureAgentInput!) {
    askLectureAgent(input: $input) {
      answer
      sources {
        id
        topic
        question
        startTime
        endTime
      }
    }
  }
`;

export const CLEAR_CHAT_MUTATION = gql`
  mutation ClearChat($lectureId: Int!) {
    clearChat(lectureId: $lectureId) {
      success
      message
    }
  }
`;

export const CHAT_HISTORY_QUERY = gql`
  query ChatHistory($lectureId: Int!) {
    chatHistory(lectureId: $lectureId) {
      id
      question
      answer
      sources {
        id
        topic
        question
        startTime
        endTime
      }
      createdAt
    }
  }
`;
