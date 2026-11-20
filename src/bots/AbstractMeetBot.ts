import { IUploader } from '../middleware/disk-uploader';

export interface BotLaunchParams {
  provider: 'google' | 'microsoft' | 'zoom';
  url: string;
  name: string;
  teamId: string;
  userId: string;
  bearerToken: string;
  timezone: string;
  botId?: string;
  eventId?: string;
}

export interface JoinParams {
  url: string;
  name: string;
  // Zoom only: some meetings ask for an email on the join form.
  email?: string;
  bearerToken: string;
  teamId: string;
  timezone: string;
  userId: string;
  botId?: string;
  eventId?: string;
  uploader: IUploader;
}

export abstract class AbstractMeetBot {
  abstract join(params: JoinParams): Promise<void>;
}
