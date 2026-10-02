// Generated from jobs_radar/profile.schema.json. Do not edit.
import type {Profile} from './profile-types';
export declare const JobsProfileContract: {version:number; options: Record<string,string[]>; assertProfile(value:unknown): Profile; validate(value:unknown): {valid:boolean;errors:string[]}; projectAnswerProfile(value:unknown,options?:{partial?:boolean}): Partial<Profile>};
