export const syntheticPiece = Object.freeze({
  actions() {
    return Object.freeze({
      "echo-read": Object.freeze({
        name: "echo-read",
        classification: "READ",
        async run({ auth, propsValue }) {
          if (auth !== "fixture-secret") throw new Error("fixture auth rejected");
          return { echo: propsValue.message };
        },
      }),
    });
  },
});
