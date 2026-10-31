import { Router } from 'express';
import { authLimiter } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { protect } from '../middleware/auth.middleware';
import * as C from '../controllers/auth.controller';

const router = Router();

router.post('/login',             authLimiter, C.loginValidators,           validate, C.login);
router.post('/resend-login-otp',  authLimiter, C.resendLoginOtpValidators,   validate, C.resendLoginOtp);
router.post('/refresh-token',                                               C.refreshToken);
router.post('/logout',                                                      C.logout);
router.post('/logout-all',                                                  C.logoutAll);
router.get ('/me',                protect,                                  C.getMe);
router.patch('/me',               protect,                                  C.updateMe);
router.get ('/google',                                                      C.googleRedirect);
router.get ('/google/callback',                                             C.googleCallback);

export default router;
