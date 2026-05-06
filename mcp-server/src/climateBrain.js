const CLIMATE_BRAIN_URL =
  "https://us-central1-aclymate-internal.cloudfunctions.net/knowledgeCompose";

const callClimateBrain = async ({ prompt, tags = ["carbon-accounting"], limit = 5 }) => {
  const response = await fetch(CLIMATE_BRAIN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.INTERNAL_API_KEY,
    },
    body: JSON.stringify({ prompt, tags, limit }),
  });

  if (!response.ok) {
    throw new Error(`Climate Brain error ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  return data.response || "";
};

export { callClimateBrain };
