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

export const DELETE_CHAT_ENTRY_MUTATION = gql`
  mutation DeleteChatEntry($id: Int!) {
    deleteChatEntry(id: $id)
  }
`;

export const RENAME_CHAT_ENTRY_MUTATION = gql`
  mutation RenameChatEntry($id: Int!, $label: String!) {
    renameChatEntry(id: $id, label: $label)
  }
`;

export const PAGINATED_CHAT_HISTORY_QUERY = gql`
  query PaginatedChatHistory($lectureId: Int!, $limit: Int!, $offset: Int!) {
    paginatedChatHistory(lectureId: $lectureId, limit: $limit, offset: $offset) {
      entries {
        id
        question
        answer
        createdAt
      }
      total
      hasMore
    }
  }
`;

export const SEARCH_CHAT_HISTORY_QUERY = gql`
  query SearchChatHistory($lectureId: Int!, $query: String!) {
    searchChatHistory(lectureId: $lectureId, query: $query) {
      id
      question
      answer
      createdAt
    }
  }
`;
