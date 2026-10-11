/** Shared effective model credential. Never log the returned value. */
export function providerApiKey(env:NodeJS.ProcessEnv=process.env):string {
 return env.PROVIDER_API_KEY?.trim()?env.PROVIDER_API_KEY:env.OPENAI_API_KEY??'';
}
