// Generated from jobs_radar/profile.schema.json. Do not edit.
export type Profile = {
  "profileName": string;
  "nameData": {
  "firstName"?: string;
  "middleName"?: string;
  "lastName"?: string;
  "prefix"?: string;
  "suffix"?: string;
  "preferredFirstName"?: string;
  "preferredMiddleName"?: string;
  "preferredLastName"?: string;
  "preferredName"?: boolean;
  [key: string]: any;
};
  "addressData": {
  "line1"?: string;
  "line2"?: string;
  "city"?: string;
  "state"?: string;
  "postalCode"?: string;
  "country"?: string;
  [key: string]: any;
};
  "contactData": {
  "email"?: string;
  "phoneNumber"?: string;
  "phoneCountryCode"?: string;
  "phoneDeviceType"?: string;
  [key: string]: any;
};
  "jobData": Array<{
  "jobTitle"?: string;
  "company"?: string;
  "location"?: string;
  "startDate"?: string;
  "endDate"?: string;
  "description"?: string;
  "currentlyWorkHere"?: boolean;
  [key: string]: any;
}>;
  "educationData": Array<{
  "school"?: string;
  "degree"?: string;
  "fieldOfStudy"?: string;
  "startDate"?: string;
  "endDate"?: string;
  "gpa"?: string;
  "currentlyAttending"?: boolean;
  "graduationDate"?: string;
  [key: string]: any;
}>;
  "languageData": Array<{
  "language"?: string;
  "proficiency"?: string;
  "fluent"?: boolean;
  [key: string]: any;
}>;
  "resumeData": {
  "resumeBase64"?: string;
  "fileName"?: string;
  "dateUploaded"?: string;
  "fileSize"?: number;
  [key: string]: any;
};
  "websiteData": {
  "websites"?: Array<string>;
  "linkedin"?: string;
  "github"?: string;
  "portfolio"?: string;
  [key: string]: any;
};
  "employmentData": {
  "gender"?: string;
  "ethnicity"?: string;
  "age"?: number | string;
  "eligibilityUS"?: boolean | "undisclosed" | "";
  "sponsorship"?: boolean | "undisclosed" | "";
  "disability"?: boolean | "undisclosed" | "";
  "veteran"?: boolean | "undisclosed" | "";
  "hispanicOrLatino"?: boolean | "undisclosed" | "";
  [key: string]: any;
};
  "skillsData"?: Array<string>;
  "applicationData"?: {
  "earliestStartDate"?: string;
  "weeklyHours"?: "" | "10" | "15" | "20" | "25" | "30" | "35" | "40";
  "highestCompletedEducation"?: string;
  "visaStatus"?: string;
  "salaryPreference"?: "" | "posted_range" | "negotiable" | "custom";
  "salaryCurrency"?: string;
  "salaryPeriod"?: "" | "hourly" | "annual_base" | "annual_total";
  "salaryMin"?: string;
  "salaryMax"?: string;
  "pronouns"?: string;
  "interviewLanguage"?: string;
  "aiNotes"?: string;
  "sponsorshipNow"?: boolean;
  "sponsorshipFuture"?: boolean;
  "willingToRelocate"?: boolean;
  "willingToWorkOnsite"?: boolean;
  "willingToTravel"?: boolean;
  "hasRelatedPeopleAtWork"?: boolean;
};
};
export type ApplicationDetails = {
  "earliestStartDate"?: string;
  "weeklyHours"?: "" | "10" | "15" | "20" | "25" | "30" | "35" | "40";
  "highestCompletedEducation"?: string;
  "visaStatus"?: string;
  "salaryPreference"?: "" | "posted_range" | "negotiable" | "custom";
  "salaryCurrency"?: string;
  "salaryPeriod"?: "" | "hourly" | "annual_base" | "annual_total";
  "salaryMin"?: string;
  "salaryMax"?: string;
  "pronouns"?: string;
  "interviewLanguage"?: string;
  "aiNotes"?: string;
  "sponsorshipNow"?: boolean;
  "sponsorshipFuture"?: boolean;
  "willingToRelocate"?: boolean;
  "willingToWorkOnsite"?: boolean;
  "willingToTravel"?: boolean;
  "hasRelatedPeopleAtWork"?: boolean;
};
