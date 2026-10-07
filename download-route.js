// npm install archiver
const express = require("express");
const { ZipArchive } = require("archiver");
const fs = require("fs");

const router = express.Router();

// Allowlist: the client can only pick a name from here, never a path.
const DEPLOYMENTS = {
    deployment1:  { location: "/var/www/deployment1",  url: "http://13.200.19.112/deployment1/" },
    deployement2: { location: "/var/www/deployement2", url: "http://13.200.19.112/deployement2/" },
    deployement3: { location: "/var/www/deployement3", url: "http://13.200.19.112/deployement3/" }
};

// GET /download/:deployment/:buildNumber
router.get("/download/:deployment/:buildNumber", (req, res) => {
    const { deployment, buildNumber } = req.params;
    const target = DEPLOYMENTS[deployment];

    if (!target) {
        return res.status(404).json({ message: "Unknown deployment" });
    }

    if (!/^\d+$/.test(buildNumber)) {
        return res.status(400).json({ message: "Invalid build number" });
    }

    if (!fs.existsSync(target.location)) {
        return res.status(404).json({
            message: "Deployed project folder was not found"
        });
    }

    const fileName = `${deployment}-build-${buildNumber}.zip`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
        "Content-Disposition",
        `attachment; filename="${fileName}"`
    );

    const archive = new ZipArchive({ zlib: { level: 9 } });

    archive.on("error", (err) => {
        console.error("ZIP error:", err);

        if (!res.headersSent) {
            res.status(500).json({ message: "Could not create ZIP" });
        } else {
            res.destroy(err);
        }
    });

    archive.pipe(res);

    // Deployment details — no secrets such as DB_PASSWORD.
    const details = {
        deployment,
        buildNumber: Number(buildNumber),
        status: "SUCCESS",
        location: target.location,
        url: target.url,
        downloadedAt: new Date().toISOString()
    };

    archive.append(
        JSON.stringify(details, null, 2),
        { name: "deployment-details.json" }
    );

    // Deployed project.
    // Exclude secrets and unnecessary/heavy folders.
    archive.glob(
        "**/*",
        {
            cwd: target.location,
            dot: true,
            ignore: [
                ".env",
                "**/.env",
                ".env.*",
                ".git/**",
                "node_modules/**"
            ]
        },
        {
            prefix: "project"
        }
    );

    archive.finalize();
});

module.exports = router;
