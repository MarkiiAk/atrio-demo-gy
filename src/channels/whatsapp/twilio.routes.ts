import { Router } from 'express';
import { handleInboundWhatsApp, handleStatusCallback } from './twilio.controller';
import { twilioSignature } from './twilio-signature.middleware';

export const twilioRouter: Router = Router();

// Twilio envía application/x-www-form-urlencoded; el parser se monta en app.ts.
twilioRouter.post('/whatsapp', twilioSignature, handleInboundWhatsApp);
twilioRouter.post('/status', twilioSignature, handleStatusCallback);
