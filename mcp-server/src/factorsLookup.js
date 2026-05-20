const FACTORS_LOOKUP_URL =
  "https://us-central1-aclymate-internal.cloudfunctions.net/factorsLookup";

const callFactorsLookup = async ({ query, factor_type, context_hints }) => {
  const response = await fetch(FACTORS_LOOKUP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.INTERNAL_API_KEY,
    },
    body: JSON.stringify({ query, factor_type, context_hints }),
  });

  if (!response.ok) {
    throw new Error(
      `factorsLookup error ${response.status}: ${await response.text()}`,
    );
  }

  return response.json();
};

export { callFactorsLookup };
