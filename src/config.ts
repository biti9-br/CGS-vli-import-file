declare global {
  interface Window {
    ENV: {
      GEMINI_API_KEY: string;
      MY_APP_URL: string;
    };
  }
}

export const config = {
  GEMINI_API_KEY: window.ENV?.GEMINI_API_KEY || "",
  MY_APP_URL: window.ENV?.MY_APP_URL || "",
};
