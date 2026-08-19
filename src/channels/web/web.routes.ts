import { Router } from 'express';
import { handleWebChat, handleWebMeta, handleWebReset } from './web.controller';

export const webRouter: Router = Router();

webRouter.get('/meta', handleWebMeta);
webRouter.post('/chat', handleWebChat);
webRouter.post('/reset', handleWebReset);
