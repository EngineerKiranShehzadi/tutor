import {GraphQLError} from 'graphql';
import type {GraphQLContext} from '../context';
import type {AuthenticatedRequest} from '../../types';
import {AppError} from '../../middleware/errorHandler';
import {importRagBenchmark,listRagBenchmarks} from '../../services/rag-benchmark-report.service';
function admin(ctx:GraphQLContext){
 const user=(ctx.req as AuthenticatedRequest).user;
 if(!user)throw new GraphQLError('Unauthorized',{extensions:{code:'UNAUTHENTICATED'}});
 if(user.role!=='ADMIN')throw new GraphQLError('Forbidden',{extensions:{code:'FORBIDDEN'}});
 return user.id;
}
async function guarded<T>(fn:()=>Promise<T>):Promise<T>{
 try{return await fn();}
 catch(e){
  if(e instanceof AppError)throw new GraphQLError(e.message,{extensions:{code:e.statusCode===409?'CONFLICT':'BAD_REQUEST',status:e.statusCode}});
  throw e;
 }
}
export const ragBenchmarkResolvers={
 Query:{
  ragBenchmarkRuns:(_:unknown,{limit}:{limit?:number},ctx:GraphQLContext)=>
   guarded(async()=>{admin(ctx);return listRagBenchmarks(limit);})
 },
 Mutation:{
  importRagBenchmark:(_:unknown,{label,goldJson,predictionsJson}:{label:string;goldJson:string;predictionsJson:string},ctx:GraphQLContext)=>
   guarded(()=>importRagBenchmark(admin(ctx),label,goldJson,predictionsJson))
 }
};
