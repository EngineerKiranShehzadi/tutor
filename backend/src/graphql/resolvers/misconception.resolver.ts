import { GraphQLError } from 'graphql';
import { GraphQLContext } from '../context';
import { AuthenticatedRequest } from '../../types';
import { AppError } from '../../middleware/errorHandler';
import {getMisconceptions,createMisconception,setDistractorMisconception,getDistractorReview,
 myMisconceptionEvidence,myOutcomeTimeline} from '../../services/misconception.service';
function actor(ctx:GraphQLContext,role:'STUDENT'|'ADMIN'):string {
 const u=(ctx.req as AuthenticatedRequest).user;
 if(!u)throw new GraphQLError('Unauthorized',{extensions:{code:'UNAUTHENTICATED'}});
 if(u.role!==role)throw new GraphQLError('Forbidden',{extensions:{code:'FORBIDDEN'}});
 return u.id;
}
async function safe<T>(fn:()=>Promise<T>):Promise<T>{
 try{return await fn();}catch(e){
  if(e instanceof AppError)throw new GraphQLError(e.message,{extensions:{code:'BAD_REQUEST',status:e.statusCode}});
  throw e;
 }
}
export const misconceptionResolvers={
 Query:{
  courseMisconceptions:(_:unknown,{courseId}:{courseId:number},ctx:GraphQLContext)=>safe(async()=>{actor(ctx,'ADMIN');return getMisconceptions(courseId);}),
  misconceptionQuestionReview:(_:unknown,{courseId,limit}:{courseId:number;limit?:number},ctx:GraphQLContext)=>safe(async()=>{actor(ctx,'ADMIN');return getDistractorReview(courseId,limit);}),
  myMisconceptionEvidence:(_:unknown,{courseId}:{courseId:number},ctx:GraphQLContext)=>safe(()=>myMisconceptionEvidence(actor(ctx,'STUDENT'),courseId)),
  myOutcomeTimeline:(_:unknown,{courseId}:{courseId:number},ctx:GraphQLContext)=>safe(()=>myOutcomeTimeline(actor(ctx,'STUDENT'),courseId)),
 },
 Mutation:{
  createMisconception:(_:unknown,{courseId,outcomeId,code,description}:{courseId:number;outcomeId:number;code:string;description:string},ctx:GraphQLContext)=>safe(async()=>{actor(ctx,'ADMIN');return createMisconception(courseId,outcomeId,code,description);}),
  setDistractorMisconception:(_:unknown,{courseId,questionId,optionIndex,misconceptionId}:{courseId:number;questionId:number;optionIndex:number;misconceptionId:number|null},ctx:GraphQLContext)=>safe(async()=>{actor(ctx,'ADMIN');return setDistractorMisconception(courseId,questionId,optionIndex,misconceptionId);}),
 }};
