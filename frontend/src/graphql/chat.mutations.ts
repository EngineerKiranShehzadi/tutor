import { gql } from '@apollo/client';

export const SEND_CHAT_MESSAGE_MUTATION = gql`
  mutation SendChatMessage($input: SendChatMessageInput!) {
    sendChatMessage(input: $input) {
      explanation
      agentName
      sources {
        id
        title
      }
    }
  }
`;
