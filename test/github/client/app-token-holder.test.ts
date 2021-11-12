import AppTokenHolder from "../../../src/github/client/app-token-holder";
import fs from "fs";

describe("AppTokenHolder", () => {

	const privateKeyBase64 = fs.readFileSync("./test/github/client/dummy.key", "utf-8");
	const privateKey = Buffer.from(privateKeyBase64, "base64").toString("ascii");

	beforeAll(() => {
		jest.useFakeTimers("modern");
	});

	afterAll(() => {
		jest.useRealTimers();
	})

	it("Re-generates expired tokens", async () => {
		const appTokenHolder = new AppTokenHolder(privateKey, "42");

		jest.setSystemTime(new Date(2021, 10, 25, 10, 0));
		const token1 = appTokenHolder.getAppToken();
		expect(token1).toBeTruthy();

		// after 5 minutes we still expect the same token because it's still valid
		jest.setSystemTime(new Date(2021, 10, 25, 10, 5));
		const token2 = appTokenHolder.getAppToken();
		expect(token2).toEqual(token1);

		// after 10 minutes we expect a new token because the old one has expired
		jest.setSystemTime(new Date(2021, 10, 25, 10, 10));
		const token3 = appTokenHolder.getAppToken();
		expect(token3).not.toEqual(token1);
	});

});