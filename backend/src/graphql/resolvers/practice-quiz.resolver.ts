import { GraphQLError } from 'graphql';
import { GraphQLContext } from '../context';
import { AuthenticatedRequest } from '../../types';
import { AppError } from '../../middleware/errorHandler';
import { createPracticeQuiz, loadPracticeQuiz, submitPracticeQuiz, myPracticeQuizzes, myPracticeProgress } from '../../services/practice-quiz.service';

function studentId(ctx: GraphQLContext): string {
  const user=(ctx.req as AuthenticatedRequest).user;
  if(!user)throw new GraphQLError('Unauthorized',{extensions:{code:'UNAUTHENTICATED'}});
  if(user.role!=='STUDENT')throw new GraphQLError('Students only',{extensions:{code:'FORBIDDEN'}});
  return user.id;
}
async function wrap<T>(fn:()=>Promise<T>):Promise<T>{
  try{return await fn();}catch(e){
    if(e instanceof AppError)throw new GraphQLError(e.message,{extensions:{code:e.statusCode===404?'NOT_FOUND':'BAD_REQUEST',status:e.statusCode}});
    throw e;
  }
}
export const practiceQuizResolvers={
  Query:{
    myPracticeQuiz: (_:unknown,{id}:{id:number},ctx:GraphQLContext)=>wrap(()=>loadPracticeQuiz(studentId(ctx),id)),
    myPracticeQuizzes:(_:unknown,{courseId}:{courseId?:number|null},ctx:GraphQLContext)=>wrap(()=>myPracticeQuizzes(studentId(ctx),courseId)),
    myPracticeProgress:(_:unknown,{courseId}:{courseId?:number|null},ctx:GraphQLContext)=>wrap(()=>myPracticeProgress(studentId(ctx),courseId)),
  },
  Mutation:{
    createPracticeQuiz:(_:unknown,{courseId,lectureIds}:{courseId:number;lectureIds:number[]},ctx:GraphQLContext)=>wrap(()=>createPracticeQuiz(studentId(ctx),courseId,lectureIds)),
    submitPracticeQuiz:(_:unknown,{id,answers}:{id:number;answers:{questionId:number;selectedIndex:number}[]},ctx:GraphQLContext)=>wrap(()=>submitPracticeQuiz(studentId(ctx),id,answers)),
  }
};
