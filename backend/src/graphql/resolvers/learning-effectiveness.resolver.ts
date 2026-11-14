import {GraphQLError} from 'graphql';
import type {GraphQLContext} from '../context';
import type {AuthenticatedRequest} from '../../types';
import {AppError} from '../../middleware/errorHandler';
import {myObservedLearningProgress} from '../../services/learning-effectiveness.service';
export const learningEffectivenessResolvers={
 Query:{
  myObservedLearningProgress:async(_:unknown,{courseId}:{courseId:number},ctx:GraphQLContext)=>{
   const user=(ctx.req as AuthenticatedRequest).user;
   if(!user)throw new GraphQLError('Unauthorized',{extensions:{code:'UNAUTHENTICATED'}});
   if(user.role!=='STUDENT')throw new GraphQLError('Forbidden',{extensions:{code:'FORBIDDEN'}});
   try{return await myObservedLearningProgress(user.id,courseId);}
   catch(e){if(e instanceof AppError)throw new GraphQLError(e.message,{extensions:{code:'BAD_REQUEST',status:e.statusCode}});
    throw e;}
  }
 }
};
