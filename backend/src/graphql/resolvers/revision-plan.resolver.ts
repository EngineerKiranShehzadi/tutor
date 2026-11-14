import {GraphQLError} from 'graphql';
import type {GraphQLContext} from '../context';
import type {AuthenticatedRequest} from '../../types';
import {AppError} from '../../middleware/errorHandler';
import {listFacultyRevisionPlans,myRevisionRecommendations,upsertRevisionPlan,withdrawRevisionPlan} from '../../services/revision-plan.service';
const actor=(ctx:GraphQLContext,role:'ADMIN'|'STUDENT')=>{
 const user=(ctx.req as AuthenticatedRequest).user;
 if(!user)throw new GraphQLError('Unauthorized',{extensions:{code:'UNAUTHENTICATED'}});
 if(user.role!==role)throw new GraphQLError('Forbidden',{extensions:{code:'FORBIDDEN'}});
 return user.id;
};
async function call<T>(fn:()=>Promise<T>):Promise<T>{
 try{return await fn();}catch(e){
  if(e instanceof AppError)throw new GraphQLError(e.message,{extensions:{code:e.statusCode===404?'NOT_FOUND':'BAD_REQUEST',status:e.statusCode}});
  throw e;
 }
}
export const revisionPlanResolvers={
 Query:{
  facultyRevisionPlans:(_:unknown,{courseId}:{courseId:number},ctx:GraphQLContext)=>call(async()=>{
   actor(ctx,'ADMIN');return listFacultyRevisionPlans(courseId);
  }),
  myRevisionRecommendations:(_:unknown,{courseId}:{courseId:number},ctx:GraphQLContext)=>call(()=>
   myRevisionRecommendations(actor(ctx,'STUDENT'),courseId)),
 },
 Mutation:{
  saveRevisionPlan:(_:unknown,{courseId,outcomeId,lectureId,guidance,approve}:{courseId:number;outcomeId:number;lectureId:number;guidance:string;approve:boolean},ctx:GraphQLContext)=>call(()=>
   upsertRevisionPlan(actor(ctx,'ADMIN'),courseId,outcomeId,lectureId,guidance,approve)),
  withdrawRevisionPlan:(_:unknown,{courseId,outcomeId}:{courseId:number;outcomeId:number},ctx:GraphQLContext)=>call(async()=>{
   actor(ctx,'ADMIN');return withdrawRevisionPlan(courseId,outcomeId);
  })
 }
};
