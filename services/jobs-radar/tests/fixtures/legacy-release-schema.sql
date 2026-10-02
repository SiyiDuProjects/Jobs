-- Extracted from empty database initialized by verified release 5c0ec98de33d, including BrowserControl. No owner data.
CREATE TABLE answer_jobs(id TEXT PRIMARY KEY,digest TEXT NOT NULL,created REAL NOT NULL,state TEXT NOT NULL,result TEXT);
CREATE TABLE answer_profile_gaps(
              profile_id TEXT,question TEXT,control_type TEXT,field TEXT,answer TEXT,reason TEXT,
              profile_stamp TEXT,first_seen REAL,last_seen REAL,occurrences INTEGER,
              PRIMARY KEY(profile_id,question,control_type));
CREATE TABLE answer_requests(id TEXT PRIMARY KEY,created REAL,state TEXT);
CREATE TABLE application_progress(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
CREATE TABLE application_progress_events(event_key TEXT PRIMARY KEY,application_id TEXT,payload TEXT NOT NULL);
CREATE TABLE application_progress_migrations(name TEXT PRIMARY KEY,created REAL);
CREATE TABLE application_progress_pending(job_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
CREATE TABLE applications(job_id TEXT PRIMARY KEY,status TEXT,version INTEGER DEFAULT 0,
                updated REAL,detail TEXT DEFAULT '',evidence TEXT DEFAULT '[]',owner_run_id TEXT);
CREATE TABLE audit(id INTEGER PRIMARY KEY,job_id TEXT,event TEXT,actor TEXT,created REAL,payload TEXT);
CREATE TABLE browser_control_commands(id TEXT PRIMARY KEY,device TEXT,session TEXT,tab INTEGER,frame INTEGER,
                document TEXT,revision INTEGER,action TEXT,args TEXT,hash TEXT,state TEXT,created INTEGER,expires INTEGER,
                dispatched INTEGER,result TEXT);
CREATE TABLE browser_control_sessions(device TEXT,session TEXT,active INTEGER,seen INTEGER,pages TEXT,
                PRIMARY KEY(device,session));
CREATE TABLE browser_diagnostic_history(
        id TEXT PRIMARY KEY, device TEXT, url TEXT, first_seen INTEGER, last_seen INTEGER, data TEXT);
CREATE TABLE claim_purposes(job_id TEXT PRIMARY KEY,purpose TEXT);
CREATE TABLE claims(job_id TEXT PRIMARY KEY,lease_id TEXT,owner TEXT,expires REAL,fence INTEGER);
CREATE TABLE extension_devices(
                device_id TEXT PRIMARY KEY, token_hash TEXT UNIQUE, created REAL,
                expires REAL, last_seen REAL, revoked INTEGER DEFAULT 0);
CREATE TABLE extension_receipts(
                event_id TEXT PRIMARY KEY, device_id TEXT, checksum TEXT, payload TEXT,
                received REAL, updated REAL, state TEXT, job_id TEXT, result TEXT);
CREATE TABLE historical(identity TEXT PRIMARY KEY,status TEXT,reference TEXT);
CREATE TABLE idempotency(key TEXT PRIMARY KEY,hash TEXT,result TEXT);
CREATE TABLE job_aliases(alias_id TEXT PRIMARY KEY,canonical_id TEXT NOT NULL,created REAL);
CREATE TABLE job_role_family(job_id TEXT,kind TEXT,family TEXT,fingerprint TEXT,
                evidence TEXT,updated REAL,PRIMARY KEY(job_id,kind));
CREATE TABLE job_screening(job_id TEXT,kind TEXT,state TEXT,reason TEXT,detail TEXT,
                evidence TEXT,fingerprint TEXT,reviewed_at REAL,expires_at REAL,version INTEGER DEFAULT 1,
                manual_keep INTEGER DEFAULT 0,PRIMARY KEY(job_id,kind));
CREATE TABLE jobs(id TEXT PRIMARY KEY,identity TEXT UNIQUE,first_seen REAL,last_seen REAL);
CREATE TABLE locks(name TEXT PRIMARY KEY,owner TEXT,expires REAL);
CREATE TABLE management_documents(key TEXT PRIMARY KEY,value TEXT NOT NULL,revision INTEGER NOT NULL);
CREATE TABLE management_revisions(key TEXT,revision INTEGER,value TEXT NOT NULL,created REAL,PRIMARY KEY(key,revision));
CREATE TABLE oauth_clients(id TEXT PRIMARY KEY,payload TEXT,created REAL);
CREATE TABLE oauth_codes(hash TEXT PRIMARY KEY,payload TEXT,expires REAL);
CREATE TABLE oauth_requests(id TEXT PRIMARY KEY,client_id TEXT,params TEXT,
                expires REAL,approved INTEGER DEFAULT 0,browser_hash TEXT,csrf_hash TEXT);
CREATE TABLE oauth_tokens(hash TEXT PRIMARY KEY,kind TEXT,payload TEXT,expires REAL,family TEXT);
CREATE TABLE observations(stream TEXT,source_id TEXT,job_id TEXT,payload TEXT,
                first_seen REAL,last_seen REAL,present INTEGER DEFAULT 1,PRIMARY KEY(stream,source_id));
CREATE TABLE owner_profile_revisions(id TEXT,last_sync TEXT,profile TEXT,created REAL,PRIMARY KEY(id,last_sync));
CREATE TABLE owner_profiles(id TEXT PRIMARY KEY,profile TEXT NOT NULL,last_sync TEXT NOT NULL,deleted INTEGER DEFAULT 0);
CREATE TABLE owner_submission_undo(job_id TEXT PRIMARY KEY,version INTEGER,expires REAL,application TEXT,reviews TEXT);
CREATE TABLE profile_grants(device_id TEXT PRIMARY KEY,token_hash TEXT UNIQUE,expires REAL);
CREATE TABLE recruiting_events(mailbox TEXT,message_id TEXT,job_id TEXT,stage TEXT,
                received_at REAL,summary TEXT,match_reason TEXT,created REAL,applied INTEGER,application_before TEXT,
                PRIMARY KEY(mailbox,message_id));
CREATE TABLE recruiting_progress(job_id TEXT PRIMARY KEY,stage TEXT,received_at REAL,
                message_id TEXT,summary TEXT,version INTEGER);
CREATE TABLE recruiting_sync(mailbox TEXT PRIMARY KEY,last_success REAL,summary TEXT);
CREATE TABLE search_index(stream TEXT,source_id TEXT,job_id TEXT,source TEXT,kind TEXT,
                category TEXT,title_company TEXT,locations TEXT,h1b TEXT,active INTEGER,visible INTEGER,posted_at REAL,
                PRIMARY KEY(stream,source_id));
CREATE TABLE snapshots(stream TEXT,source_id TEXT,hash TEXT,observed_at REAL,payload TEXT,
                PRIMARY KEY(stream,source_id,hash));
CREATE TABLE source_health(stream TEXT PRIMARY KEY,last_attempt REAL,last_success REAL,
                count INTEGER,error TEXT,run_id TEXT);
CREATE TABLE web_opened(job_id TEXT,kind TEXT,opened_at REAL,PRIMARY KEY(job_id,kind));
CREATE TABLE web_sessions(hash TEXT PRIMARY KEY,request_id TEXT UNIQUE,created REAL,expires REAL,approved INTEGER DEFAULT 0);
CREATE INDEX application_progress_events_application ON application_progress_events(application_id);
CREATE UNIQUE INDEX browser_control_active ON browser_control_sessions(device) WHERE active=1;
CREATE INDEX browser_control_pending ON browser_control_commands(device,session,tab,state);
CREATE INDEX observations_job ON observations(job_id);
CREATE INDEX recruiting_events_job ON recruiting_events(job_id);
CREATE INDEX search_job ON search_index(job_id);
CREATE INDEX search_posted ON search_index(active,visible,posted_at);
