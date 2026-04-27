import { GraphQLError } from 'graphql';
import { GraphQLContext } from '../context';
import { handleChatMessage } from '../../services/rag.service';

interface SendChatMessageInput {
  lectureId: string;
  message:   string;
}

export const chatResolvers = {
  Mutation: {
    sendChatMessage: async (
      _:     unknown,
      { input }: { input: SendChatMessageInput },
      _ctx:  GraphQLContext
    ) => {
      if (!input.message.trim()) {
        throw new GraphQLError('Message cannot be empty', {
          extensions: { code: 'BAD_REQUEST' },
        });
      }

      try {
        return await handleChatMessage(input.lectureId, input.message);
      } catch {
        throw new GraphQLError('Failed to process your question. Please try again.', {
          extensions: { code: 'INTERNAL_SERVER_ERROR' },
        });
      }
    },
  },
};
