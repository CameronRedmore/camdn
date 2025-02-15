import Fastify from 'fastify'
import fastifyMultipart from '@fastify/multipart'
import dotenv from 'dotenv'
import fs from 'node:fs'
import mime from 'mime-types'
import path, { join } from 'node:path'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import sanitize from 'sanitize-filename'
import fastifyStatic from '@fastify/static'

// Load environment variables
dotenv.config()

const fastify = Fastify({
    logger: true
})

let uploadDir = process.env.UPLOAD_DIR || 'uploads'

//Convert to absolute path
if (!path.isAbsolute(uploadDir)) {
    uploadDir = path.join(process.cwd(), uploadDir)
}

fastify.register(fastifyStatic, {
    root: uploadDir,
    prefix: '/f'
});

// Handle CSS file, by sending `styles.css` file from the current directory
fastify.get('/styles.css', async (request, reply) => {
    const cssContent = await fs.promises.readFile('assets/styles.css', 'utf8')
    reply.header('Content-Type', 'text/css').send(cssContent)
});

fastify.get('/music.jpg', async (request, reply) => {
    const musicImage = await fs.promises.readFile('assets/music.jpg')
    reply.header('Content-Type', 'image/jpeg').send(musicImage)
});

const assetSizeCache = new Map()

//Find the width and height of a file either an image or video, and cache the result
async function getAssetSize(filePath) {
    if (assetSizeCache.has(filePath)) {
        return assetSizeCache.get(filePath)
    }

    const mimeType = mime.lookup(filePath) || 'application/octet-stream'

    let assetSize = { width: 0, height: 0 }

    //Use ffprobe to get the width and height of a video file
    if (mimeType.startsWith('video/')) {
        const { exec } = require('child_process')
        const { promisify } = require('util')
        const execAsync = promisify(exec)

        try {
            const { stdout } = await execAsync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 ${filePath}`)
            const [width, height] = stdout.trim().split('x').map(Number)
            assetSize = { width, height }
        } catch (error) {
            console.error(error)
        }
    //Use sharp to get the width and height of an image file
    } else if (mimeType.startsWith('image/')) {
        const sharp = require('sharp')
        try {
            const metadata = await sharp(filePath).metadata()
            assetSize = { width: metadata.width, height: metadata.height }
        } catch (error) {
            console.error(error)
        }
    }

    assetSizeCache.set(filePath, assetSize)

    return assetSize
}

// Serve HTML page with embedded file (public)
fastify.get('/s/:date/:filename', async (request, reply) => {
    let { filename, date } = request.params

    //Log the user agent
    console.log(request.headers['user-agent'])

    // Sanitize filename & date
    filename = sanitize(filename)
    date = sanitize(date)

    const uploadDir = process.env.UPLOAD_DIR || 'uploads'
    const filePath = path.join(uploadDir, date, filename)

    const joinedPath = path.join(date, filename)
    
    console.log(filePath)

    try {
        //Check if the file exists, if not, return 404
        await fs.promises.access(filePath)

        const {width, height} = await getAssetSize(filePath);

        const mimeType = mime.lookup(filename) || 'application/octet-stream'
        let fileContent = '';
        let ogTags = `<meta property="og:title" content="${process.env.SITE_NAME || 'CamDN'} - ${filename}" />
                      <meta property="og:url" content="${process.env.HOST || ''}/s/${date}/${filename}" />\n`;

        if (mimeType.startsWith('image/')) {
            fileContent = `<img src="/f/${joinedPath}" alt="${filename}" width="${width}" height="${height} />`
            ogTags += `<meta property="og:image" content="/f/${joinedPath}" />
                       <meta property="og:image:type" content="${mimeType}" />
                       <meta property="og:image:width" content="${width}" />
                       <meta property="og:image:height" content="${height}" />
                       <meta property="og:type" content="website" />
                       `
        } else if (mimeType.startsWith('video/')) {
            fileContent = `<video controls width="${width}" height="${height}><source src="/f/${joinedPath}" type="${mimeType}"></video>`
            ogTags += `<meta property="og:video" content="/f/${joinedPath}" />
                       <meta property="og:video:type" content="${mimeType}" />
                       <meta property="og:video:width" content="${width}" />
                       <meta property="og:video:height" content="${height}" />
                       <meta property="og:image" content="/f/${joinedPath}.thumb.jpg" />
                       <meta property="og:type" content="video.other" />
                       `
        } else if (mimeType.startsWith('audio/')) {
            fileContent = `<audio controls><source src="/f/${joinedPath}" type="${mimeType}"></audio>`
            ogTags += `<meta property="og:audio" content="/f/${joinedPath}" />
                       <meta property="og:audio:type" content="${mimeType}" />
                       <meta property="og:image" content="/music.jpg" />
                       <meta property="og:type" content="music.song" />`
        } else if (mimeType.startsWith('text/')) {
            const fileData = await fs.promises.readFile(filePath, 'utf8');
            fileContent = `<pre>${fileData}</pre>`
        } else {
            fileContent = `<a href="/f/$${joinedPath}">Download File</a>`
        }

        const htmlContent = await fs.promises.readFile('assets/view.html', 'utf8');

        //Replace placeholders with actual content
        const html = htmlContent
            .replaceAll('{{fileContent}}', fileContent)
            .replaceAll('{{ogTags}}', ogTags)
            .replaceAll('{{filename}}', filename)
            .replaceAll('{{joinedPath}}', joinedPath)

        reply.code(200).header('Content-Type', 'text/html').send(html)

    } catch (error) {
        reply.code(404).send({ error: 'File not found' })
    }
})

const sizeLimit = process.env.FILE_SIZE_LIMIT || 16; //Size limit in GB

// Register multipart support
fastify.register(fastifyMultipart, {
    limits: {
        files: 1,
        fileSize: sizeLimit * 1024 * 1024 * 1024, // 8GB
    }
})

// Upload endpoint (requires API key)
fastify.put('/upload', {
    preHandler: async (request, reply) => {
        const apiKey = request.headers.authorization
        if (!apiKey || apiKey !== process.env.API_KEY) {
            reply.code(401).send({ error: 'Unauthorized' })
        }
    }
}, async function (request, reply) {
    const data = await request.file()

    if (!data) {
        reply.code(400).send({ error: 'No file provided' })
        return
    }

    const uploadDir = process.env.UPLOAD_DIR || 'uploads'
    const date = new Date()
    const dateFolder = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    const fileName = data.filename
    const fullUploadDir = path.join(uploadDir, dateFolder)
    const filePath = path.join(fullUploadDir, fileName)

    try {
        // Create directory if it doesn't exist
        await fs.promises.mkdir(fullUploadDir, { recursive: true })

        await pipeline(
            data.file,
            createWriteStream(filePath)
        )
        const host = process.env.HOST || ''
        reply.code(200).send({
            message: 'File uploaded successfully',
            fileName: host.replace(/\/$/, '') + '/s/' + path.join(dateFolder, fileName)
        })

        //If the file is a video, generate a thumbnail
        const mimeType = mime.lookup(fileName) || 'application/octet-stream'
        if (mimeType.startsWith('video/')) {
            const { exec } = require('child_process')
            const { promisify } = require('util')
            const execAsync = promisify(exec)

            const thumbnailPath = path.join(fullUploadDir, fileName + '.thumb.jpg')
            try {
                await execAsync(`ffmpeg -i ${filePath} -ss 00:00:01 -vframes 1 ${thumbnailPath}`)
            } catch (error) {
                console.error(error)
            }
        }
    } catch (err) {
        reply.code(500).send({ error: 'Error uploading file' })
    }
})

// Start server
const start = async () => {
    try {
        await fastify.listen({ host: process.env.LISTEN_HOST || '0.0.0.0', port: process.env.LISTEN_PORT || 3000 })
    } catch (err) {
        fastify.log.error(err)
        process.exit(1)
    }
}

start()
