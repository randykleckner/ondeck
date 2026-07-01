const vercelHandler = require("../../api/market-data.js");

exports.handler = async function handler(event) {
  return new Promise((resolve) => {
    const req = {
      method: event.httpMethod,
      query: event.queryStringParameters || {},
    };
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) {
        this.headers[key] = value;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({
          statusCode: this.statusCode,
          headers: {
            "Content-Type": "application/json",
            ...this.headers,
          },
          body: JSON.stringify(body),
        });
      },
    };

    vercelHandler(req, res);
  });
};
