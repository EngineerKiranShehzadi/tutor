import { Router } from 'express';
import { authLimiter } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { protect } from '../middleware/auth.middleware';
import * as C from '../controllers/auth.controller';

const router = Router();

router.post('/register',        authLimiter, C.registerValidators,       validate, C.register);
router.post('/login',           authLimiter, C.loginValidators,           validate, C.login);
router.post('/refresh-token',                                                        C.refreshToken);
router.post('/logout',          protect,                                             C.logout);
router.post('/forgot-password', authLimiter, C.forgotPasswordValidators, validate, C.forgotPassword);
router.post('/reset-password/:token',        C.resetPasswordValidators,  validate, C.resetPassword);
router.get ('/me',              protect,                                             C.getMe);

export default router;
