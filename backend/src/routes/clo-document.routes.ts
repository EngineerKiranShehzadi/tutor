import {Router} from 'express';
import multer from 'multer';
import {protect,requireRole} from '../middleware/auth.middleware';
import {previewCloDocument,approveCloDocument} from '../services/clo-document.service';
import {AppError} from '../middleware/errorHandler';
const router=Router();
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:10*1024*1024,files:1},fileFilter:(_req,file,cb)=>{
 const ext=file.originalname.toLowerCase();
 const ok=(ext.endsWith('.pdf')&&['application/pdf','application/octet-stream',''].includes(file.mimetype))||
 (ext.endsWith('.docx')&&['application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/zip','application/octet-stream',''].includes(file.mimetype));
 cb(ok?null:new AppError('Only PDF/DOCX CLO documents are allowed',400),ok);
}});
router.use(protect,requireRole('ADMIN'));
router.post('/preview/:courseId',upload.single('file'),async(req,res,next)=>{
 try{
  if(!req.file)throw new AppError('Choose a CLO document',400);
  const result=await previewCloDocument(Number(req.params.courseId),req.file.originalname,req.file.buffer);
  res.json({success:true,data:result});
 }catch(e){next(e)}
});
router.post('/approve/:courseId',async(req,res,next)=>{
 try{
  if(!req.user)throw new AppError('Unauthorized',401);
  const result=await approveCloDocument(Number(req.params.courseId),req.user.id,req.body?.outcomes);
  res.json({success:true,data:result});
 }catch(e){next(e)}
});
export default router;
