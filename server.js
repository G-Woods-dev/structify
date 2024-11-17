//Define Variables for the necessary libraries we are going to use in this project
const express = require("express"); // express library 
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const csvParser = require("csv-parser");
const docx = require("docx-parser");
const OpenAI = require("openai");
const sqlite = require("sqlite3").verbose();
const { serveLogin, serveIndex, serveRegister, serveSlash } = require("./htmlHandler");
const cors = require("cors");
const session = require("express-session");
const bcrypt = require("bcryptjs"); // bcrypt library for password hashing
const http = require("http"); 
const saltRounds = 10; //The number of rounds to process the passwords in the bcrypt hasing algorithm. The higher the saltRound is, the more rounds it is hashed

// Initialize OpenAI API
const openai = new OpenAI({ apiKey:  "" });
	
const app = express();
const server = http.createServer(app);
const port = 64465; // port connected to nginx server

const db = new sqlite.Database(path.join(__dirname, "database.db"));


// cors authentication
app.use(cors({
    origin: 'https://techtitans.cc',
    credentials: true
}));

const sessionMiddleware = session({
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 1000 * 60 * 60, // 1 hour
        secure: process.env.node_env === 'production'
    }
});


//Basic middleware setup
app.use(sessionMiddleware);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));



// Database setup, using PRAGMA is SQLite specific and is used to enable foreign key constraints
db.serialize(() => {
    db.run("PRAGMA foreign_keys = ON");
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            username TEXT UNIQUE,
            password TEXT,
            email TEXT , 
            user_id INTEGER UNIQUE
        );
    `);
});

//Check Authentication for users to forward them to the pages
function isAuthenticated(req, res, next) {
    if (req.session?.userId) {
        req.userId = req.session.userId; // gather the UserID from the session
        req.username = req.session.username; // add the username
        next();
    } else {
        res.redirect('/login'); //if not authenticated return to the login page
    }
}



// Session verification endpoint
app.get('/check-session', (req, res) => {
    res.json({ isAuthenticated: !!req.session.userId });
});

//serves routes for the pages using the ./htmlHandler file to present the pages
app.get("/", isAuthenticated, serveSlash);

app.get("/index", isAuthenticated, serveIndex);

app.get("/login", serveLogin)

app.get('/register', serveRegister)

//post the login endpoints for the routes to read
app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ success: false, error: "Username and password are required" });
        }

        const user = await new Promise((resolve, reject) => {
            db.get("SELECT id, user_id, password FROM users WHERE username = ?", [username], (err, row) => {
                if (err) return reject(err);
                resolve(row);
            });
        });

        if (!user) {
            return res.status(400).json({ success: false, error: "Invalid username or password" });
        }

        const isPasswordCorrect = await bcrypt.compare(password, user.password);
        if (!isPasswordCorrect) {
            return res.status(400).json({ success: false, error: "Invalid username or password" });
        }

        // Store `user_id` in session
        req.session.userId = user.user_id; // Use `user_id` instead of `id`
        req.session.username = username;  // Optionally store the username for reference

        return res.status(200).json({ success: true, message: "Login successful", redirectUrl: "/index" });
    } catch (error) {
        console.error("Error during login:", error);
        return res.status(500).json({ success: false, error: "Internal server error" });
    }
});

app.use('/generated', express.static(path.join(__dirname, 'generated')));

app.get('/get-user-id', (req, res) => {
    if (req.session && req.session.userId) {
        res.json({ userId: req.session.userId });
    } else {
        res.status(401).json({ error: 'User not authenticated' });
    }
});


//endpoint for user file URL
app.get("/generated/:userId", isAuthenticated, (req, res) => {
    const userId = req.params.userId;
    const userDirectory = path.join(__dirname, "generated", userId.toString());

    if (!fs.existsSync(userDirectory)) {
        return res.status(404).send("User directory not found");
    }

    const files = fs.readdirSync(userDirectory);
    const fileData = files.map((file) => ({
        name: file,
        url: `/generated/${userId}/${file}`,
    }));

    res.json(fileData);
});




//endpoint to process register data
app.post("/register", async (req, res) => {
    const { username, email, password } = req.body;

    try {
        // Generate a unique 10-digit random user ID
        let randomUserId;
        let userExists = true;

        while (userExists) {
            randomUserId = Math.floor(1000000000 + Math.random() * 9000000000); // Generate random 10-digit number
            const existingUser = await new Promise((resolve, reject) => {
                db.get("SELECT user_id FROM users WHERE user_id = ?", [randomUserId], (err, row) => {
                    if (err) return reject(err);
                    resolve(row);
                });
            });
            userExists = !!existingUser;
        }

        // Check if username or email already exists
        const existingAccount = await new Promise((resolve, reject) => {
            db.get("SELECT username, email FROM users WHERE username = ? OR email = ?", [username, email], (err, row) => {
                if (err) return (row)

                resolve(row);
            });
        });



        if (existingAccount) {
            return res.status(400).send("Username or email already exists");
        }

        // Hash the password
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        // Insert the new user into the database
        await new Promise((resolve, reject) => {
            db.run(
                "INSERT INTO users (username, password, email, user_id) VALUES (?, ?, ?, ?)",
                [username, hashedPassword, email, randomUserId],
                (err) => {
                    if (err) return reject(err);
                    resolve();
                }
            );
        });

        // Creates a directory by the user ID
        const userDirectory = path.join(__dirname, "generated", randomUserId.toString());
        if (!fs.existsSync(userDirectory)) {
            fs.mkdirSync(userDirectory, { recursive: true });
        }

        // Respond with success
        res.status(201).send({
            message: "User registered successfully",
            redirectUrl: "/login",
        });
    } catch (error) {
        console.error("Error during registration:", error);
        res.status(500).send("Internal server error");
    }
});



// File Upload and Processing
const upload = multer({ dest: "uploads/" });

// Helper function to get the next available file number for the file name
function getNextFileNumber(directory, baseName) {
    const files = fs.readdirSync(directory);
    const regex = new RegExp(`^${baseName}_(\\d+)`);
    let maxNumber = 0;

    files.forEach(file => {
        const match = file.match(regex);
        if (match) {
            const number = parseInt(match[1], 10);
            if (number > maxNumber) {
                maxNumber = number;
            }
        }
    });

    return maxNumber + 1;
}

app.post("/upload", isAuthenticated, upload.single("file"), async (req, res) => {
    const file = req.file;
    const { formatType } = req.body;
    const userId = req.userId; // Retrieve `userId` from the request object

    if (!file || !formatType || !userId) {
        return res.status(400).json({ error: "File, format type, and user authentication are required" });
    }

    try {
        // Define user-specific directory under "generated"
        const userDirectory = path.join(__dirname, "generated", userId.toString());
        if (!fs.existsSync(userDirectory)) {
            fs.mkdirSync(userDirectory, { recursive: true }); // Create directory if it doesn't exist
        }

        // Determine next file number for the user
        const baseName = "structured_data";
        const fileNumber = getNextFileNumber(userDirectory, baseName);
        const outputFileName = `${baseName}_${fileNumber}${formatType}`;
        const outputFilePath = path.join(userDirectory, outputFileName);

        // Read file contents and generate AI output
        const fileType = path.extname(file.originalname).toLowerCase();
        const rawData = await readFileContent(file.path, fileType);
        const aiGeneratedOutput = await generateStructuredData(rawData, formatType);

        // Save AI-generated output to the user's specific directory
        fs.writeFileSync(outputFilePath, aiGeneratedOutput);

        res.json({
            fileName: outputFileName,
            filePath: `/generated/${userId}/${outputFileName}`, // Public file path for download
            generatedOutput: aiGeneratedOutput,
        });
    } catch (error) {
        console.error("Error processing file:", error);
        res.status(500).json({ error: "An error occurred while processing the file" });
    } finally {
        // Remove temporary uploaded file
        fs.unlinkSync(file.path);
    }
});




//download endpoint for downloading file link
app.get("/download/:filename", isAuthenticated, (req, res) => {
    const filePath = path.join(__dirname, "generated", req.params.filename);
    res.download(filePath, (err) => {
        if (err) {
            console.error("Error downloading file:", err);
            res.status(500).send("Error downloading file");
        }
    });
});

//function to prompt the API to structure the data
const generateStructuredData = async (rawData, formatType) => {
    try {
        // Estimate token size
        const estimatedTokens = rawData.join("\n").length / 2;


        //token limit checker
        const tokenLimit = 16385;

        // Check if the input exceeds the token limit
        if (estimatedTokens > tokenLimit) {
            return `The input data exceeds the token limit of ${tokenLimit}. Please provide a smaller input.`;
        }

        // Construct the prompt
        const prompt = `
            The uploaded file contains raw and unstructured data. Parse through the file, read the data, and use it to generate structured output in the form of a ${formatType} file.

            Rules:
            write the entire file necessary out, do not truncate anything, and do not change the order of the data.
            Make sure you create a table for each data set added, the columns should be relative to the data
            Do not include comments, explanations, or any additional text. Provide only the SQL code.    
            Do not include any code block tags such as \`\`\`sql or \`\`\`. Do not add any comments, just the data.

            Raw Data:
            ${rawData.join("\n")}
        `;

        // Call OpenAI API
        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                { role: "system", content: "You are an expert data parser and formatter." },
                { role: "user", content: prompt },
            ],
        });

        return completion.choices[0].message.content.trim();
    } catch (error) {
        console.error("Error generating structured data:", error.message);
        throw new Error(
            error.message || "Failed to generate structured data using AI. Please try again."
        );
    }
};


// File Reading Assistant
const readFileContent = (filePath, fileType) => {
    return new Promise((resolve, reject) => {
        if (fileType === ".txt") {
            fs.readFile(filePath, "utf8", (err, data) => {
                if (err) return reject(err);
                resolve(data.split("\n"));
            });
        } else if (fileType === ".csv") {
            const rows = [];
            const chunkSize = 100; // Adjustable chunk size for testing
            let headers = null;
            let chunkData = [];

            const processChunk = (chunk) => {
                if (!headers) headers = Object.keys(chunk[0]);
                return chunk.map(row => headers.map(header => row[header] || "").join(","));
            };

            fs.createReadStream(filePath)
                .pipe(csvParser())
                .on("data", (row) => {
                    chunkData.push(row);
                    if (chunkData.length >= chunkSize) {
                        const processedChunk = processChunk(chunkData);
                        rows.push(...processedChunk); // Push processed chunk to rows
                        chunkData = []; // Clear the chunk data
                    }
                })

                .on("end", () => {
                    if (chunkData.length > 0) {
                        const processedChunk = processChunk(chunkData);
                        rows.push(...processedChunk);
                    }

                    if (rows.length === 0) {
                        reject(new Error("CSV file is empty or malformed"));
                    } else {

                        resolve(rows);
                    }
                })
                .on("error", (err) => reject(err));
        } else if (fileType === ".docx") {
            docx.parse(filePath, (err, data) => {
                if (err) return reject(err);
                resolve(data.split("\n"));
            });
        } else {
            reject(new Error("Unsupported file type"));
        }
    });
};

// Create "generated" folder if it doesn't exist
if (!fs.existsSync(path.join(__dirname, "generated"))) {
    fs.mkdirSync(path.join(__dirname, "generated"));
}

// Start server
server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
