require("dotenv").config();

const express = require("express");

const app = express();
const PORT = 5000;

app.use(express.json());
app.use(express.static("public"));

const deployments = {
    deployment1: "/var/www/deployment1",
    deployement2: "/var/www/deployement2",
    deployement3: "/var/www/deployement3"
};

const JENKINS_URL = process.env.JENKINS_URL;
const JENKINS_USER = process.env.JENKINS_USER;
const JENKINS_TOKEN = process.env.JENKINS_TOKEN;

function getJenkinsAuth() {
    return Buffer
        .from(`${JENKINS_USER}:${JENKINS_TOKEN}`)
        .toString("base64");
}

async function jenkinsFetch(url, options = {}) {
    return fetch(url, {
        ...options,
        headers: {
            ...(options.headers || {}),
            "Authorization": `Basic ${getJenkinsAuth()}`
        }
    });
}

app.get("/api/health", (req, res) => {
    res.json({
        status: "ok",
        service: "deployment-system"
    });
});


/*
 * Trigger Jenkins deployment
 */
app.post("/api/deploy", async (req, res) => {
    const { deployment, env } = req.body;

    if (!deployment) {
        return res.status(400).json({
            status: "error",
            message: "deployment is required"
        });
    }

    const deploymentPath = deployments[deployment];

    if (!deploymentPath) {
        return res.status(400).json({
            status: "error",
            message: "Invalid deployment name",
            availableDeployments: Object.keys(deployments)
        });
    }

    let envVariables = "";

    if (env) {
        const lines = String(env)
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line && !line.startsWith("#"));

        const blockedVariables = [
            "PATH",
            "LD_PRELOAD",
            "LD_LIBRARY_PATH",
            "HOME",
            "JENKINS_URL",
            "JENKINS_USER",
            "JENKINS_TOKEN"
        ];

        for (const line of lines) {
            const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);

            if (!match) {
                return res.status(400).json({
                    status: "error",
                    message: `Invalid environment variable format: ${line}`
                });
            }

            const key = match[1];

            if (blockedVariables.includes(key)) {
                return res.status(400).json({
                    status: "error",
                    message: `Environment variable ${key} is not allowed`
                });
            }
        }

        envVariables = lines.join("\n");
    }

    try {
        const params = new URLSearchParams();

        params.append("DEPLOYMENT", deployment);
        params.append("ENV_VARIABLES", envVariables);

        const response = await jenkinsFetch(
            `${JENKINS_URL}/job/Portfolio-Deployment/buildWithParameters`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                body: params.toString()
            }
        );

        if (!response.ok) {
            throw new Error(
                `Jenkins returned HTTP ${response.status}`
            );
        }

        /*
         * Jenkins returns the queue item URL in the Location header.
         * Example:
         * /queue/item/47/
         */
        const locationHeader = response.headers.get("location");

        let queueId = null;

        if (locationHeader) {
            const match = locationHeader.match(/\/queue\/item\/(\d+)\//);

            if (match) {
                queueId = Number(match[1]);
            }
        }

        if (queueId === null) {
            throw new Error("Jenkins did not return a queue ID");
        }

        console.log(
            `Jenkins deployment queued: queue=${queueId}, deployment=${deployment}`
        );

        res.json({
            status: "queued",
            message: "Deployment queued in Jenkins",
            deployment,
            location: deploymentPath,
            queueId
        });

    } catch (error) {
        console.error("Jenkins deployment error:", error.message);

        res.status(500).json({
            status: "error",
            message: "Failed to trigger Jenkins deployment",
            error: error.message
        });
    }
});


/*
 * Check Jenkins queue item.
 *
 * Once Jenkins creates the build, this returns:
 *
 * {
 *   status: "building",
 *   buildNumber: 25
 * }
 */
app.get("/api/deploy/status/queue/:queueId", async (req, res) => {
    const queueId = Number(req.params.queueId);

    if (!Number.isInteger(queueId) || queueId < 1) {
        return res.status(400).json({
            status: "error",
            message: "Invalid queue ID"
        });
    }

    try {
        const response = await jenkinsFetch(
            `${JENKINS_URL}/queue/item/${queueId}/api/json`
        );

        if (!response.ok) {
            throw new Error(
                `Jenkins returned HTTP ${response.status}`
            );
        }

        const data = await response.json();

        if (data.cancelled) {
            return res.json({
                status: "failed",
                message: "Jenkins queue item was cancelled",
                queueId
            });
        }

        if (data.executable && data.executable.number) {
            return res.json({
                status: "building",
                message: "Jenkins build started",
                queueId,
                buildNumber: data.executable.number
            });
        }

        return res.json({
            status: "queued",
            message: data.why || "Waiting for Jenkins executor",
            queueId
        });

    } catch (error) {
        console.error("Jenkins queue status error:", error.message);

        res.status(500).json({
            status: "error",
            message: "Unable to check Jenkins queue",
            error: error.message
        });
    }
});


/*
 * Check actual Jenkins build status.
 */
app.get("/api/deploy/status/build/:buildNumber", async (req, res) => {
    const buildNumber = Number(req.params.buildNumber);

    if (!Number.isInteger(buildNumber) || buildNumber < 1) {
        return res.status(400).json({
            status: "error",
            message: "Invalid build number"
        });
    }

    try {
        const response = await jenkinsFetch(
            `${JENKINS_URL}/job/Portfolio-Deployment/${buildNumber}/api/json`
        );

        if (!response.ok) {
            throw new Error(
                `Jenkins returned HTTP ${response.status}`
            );
        }

        const data = await response.json();

        if (data.building) {
            return res.json({
                status: "building",
                message: "Jenkins pipeline is running",
                buildNumber,
                building: true,
                result: null
            });
        }

        if (data.result === "SUCCESS") {
            return res.json({
                status: "success",
                message: "Jenkins pipeline completed successfully",
                buildNumber,
                building: false,
                result: "SUCCESS"
            });
        }

        return res.json({
            status: "failed",
            message: "Jenkins pipeline failed",
            buildNumber,
            building: false,
            result: data.result || "UNKNOWN"
        });

    } catch (error) {
        console.error("Jenkins build status error:", error.message);

        res.status(500).json({
            status: "error",
            message: "Unable to check Jenkins build",
            error: error.message
        });
    }
});


app.use("/api/deploy", require("./download-route"));

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Deployment API running on port ${PORT}`);
});
