import { GraphQLError } from 'graphql';
import { GraphQLContext } from '../context';
import { AuthenticatedRequest } from '../../types';
import { AppError } from '../../middleware/errorHandler';
import {
  listCourseOutcomes,createCourseOutcome,updateCourseOutcome,setLectureOutcome,
  mapQuestionOutcome,unmapQuestionOutcome,outcomeQuestions,studentOutcomeProgress,facultyOutcomeSummary,
} from '../../services/learning-outcome.service';

function requireRole(ctx:GraphQLContext,role?:'ADMIN'|'STUDENT'):string {
  const user=(ctx.req as AuthenticatedRequest).user;
  if(!user)throw new GraphQLError('Unauthorized',{extensions:{code:'UNAUTHENTICATED'}});
  if(role&&user.role!==role)throw new GraphQLError('Forbidden',{extensions:{code:'FORBIDDEN'}});
  return user.id;
}
async function wrap<T>(fn:()=>Promise<T>):Promise<T>{
  try{return await fn();}catch(e){
    if(e instanceof AppError)throw new GraphQLError(e.message,{extensions:{code:e.statusCode===404?'NOT_FOUND':'BAD_REQUEST',status:e.statusCode}});
    throw e;
  }
}
export const learningOutcomeResolvers={
  Query:{
    courseLearningOutcomes:(_:unknown,{courseId}:{courseId:number},ctx:GraphQLContext)=>wrap(async()=>{
      requireRole(ctx);return listCourseOutcomes(courseId);
    }),
    myOutcomeProgress:(_:unknown,{courseId}:{courseId:number},ctx:GraphQLContext)=>wrap(()=>studentOutcomeProgress(requireRole(ctx,'STUDENT'),courseId)),
    facultyOutcomeSummary:(_:unknown,{courseId}:{courseId:number},ctx:GraphQLContext)=>wrap(async()=>{requireRole(ctx,'ADMIN');return facultyOutcomeSummary(courseId);}),
    learningOutcomeQuestions:(_:unknown,{courseId,limit}:{courseId:number;limit?:number},ctx:GraphQLContext)=>wrap(async()=>{requireRole(ctx,'ADMIN');return outcomeQuestions(courseId,limit);}),
  },
  Mutation:{
    createLearningOutcome:(_:unknown,{courseId,code,description}:{courseId:number;code:string;description:string},ctx:GraphQLContext)=>wrap(async()=>{requireRole(ctx,'ADMIN');return createCourseOutcome(courseId,code,description);}),
    updateLearningOutcome:(_:unknown,{id,description}:{id:number;description:string},ctx:GraphQLContext)=>wrap(async()=>{requireRole(ctx,'ADMIN');return updateCourseOutcome(id,description);}),
    setLectureLearningOutcome:(_:unknown,{courseId,lectureId,outcomeId,selected}:{courseId:number;lectureId:number;outcomeId:number;selected:boolean},ctx:GraphQLContext)=>wrap(async()=>{requireRole(ctx,'ADMIN');return setLectureOutcome(courseId,lectureId,outcomeId,selected);}),
    mapPracticeQuestionOutcome:(_:unknown,{courseId,questionId,outcomeId}:{courseId:number;questionId:number;outcomeId:number},ctx:GraphQLContext)=>wrap(async()=>{requireRole(ctx,'ADMIN');return mapQuestionOutcome(courseId,questionId,outcomeId);}),
    unmapPracticeQuestionOutcome:(_:unknown,{courseId,questionId}:{courseId:number;questionId:number},ctx:GraphQLContext)=>wrap(async()=>{requireRole(ctx,'ADMIN');return unmapQuestionOutcome(courseId,questionId);}),
  }
};
