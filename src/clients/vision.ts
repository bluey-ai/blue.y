import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface ImageAnalysis {
  description: string;
  extractedText: string;
  errorScreenshot: boolean;
  detectedIssue?: string;
}

export class VisionClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor() {
    this.apiKey = config.vision.apiKey;
    this.baseUrl = config.vision.baseUrl;
    this.model = config.vision.model;
  }

  isEnabled(): boolean {
    return config.vision.enabled;
  }

  // Analyze an image from a URL (Teams attachment URL)
  async analyzeImageUrl(imageUrl: string, authToken?: string): Promise<ImageAnalysis> {
    // Download image first, then send as base64 (Teams URLs need auth)
    const imageBase64 = await this.downloadImage(imageUrl, authToken);
    if (!imageBase64) {
      return {
        description: 'Could not download image',
        extractedText: '',
        errorScreenshot: false,
      };
    }
    return this.analyzeBase64(imageBase64);
  }

  // Analyze a base64-encoded image
  async analyzeBase64(base64Data: string): Promise<ImageAnalysis> {
    if (!this.isEnabled()) {
      return {
        description: 'Vision AI not configured',
        extractedText: '',
        errorScreenshot: false,
      };
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}/chat/completions`,
        {
          model: this.model,
          max_tokens: 1024,
          messages: [
            {
              role: 'system',
              content: `You are an IT support image analyzer for a Kubernetes-hosted platform. Analyze screenshots and images sent by users reporting issues.

Your job:
1. Extract ALL visible text from the image (OCR)
2. Identify if this is an error screenshot (error page, stack trace, 403/404/500, timeout, etc.)
3. Describe what the image shows
4. If it's an error, identify the specific issue (e.g., "403 Forbidden", "Java NullPointerException in backend logs", "timeout after 30s")

${process.env.AI_VISION_CONTEXT || 'No known services configured. Set AI_VISION_CONTEXT env var to describe your services.'}

Respond in JSON:
{
  "description": "what the image shows",
  "extractedText": "all visible text, especially error messages",
  "errorScreenshot": true/false,
  "detectedIssue": "specific issue identified, or null"
}`,
            },
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/png;base64,${base64Data}`,
                    detail: 'high',
                  },
                },
                {
                  type: 'text',
                  text: 'Analyze this screenshot. Extract all text and identify any errors or issues shown.',
                },
              ],
            },
          ],
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        },
      );

      const text = response.data.choices?.[0]?.message?.content || '';

      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
      } catch {
        // Fall through to default
      }

      return {
        description: text,
        extractedText: '',
        errorScreenshot: false,
      };
    } catch (err) {
      logger.error('[Vision] Analysis failed', err);
      return {
        description: `Vision analysis failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        extractedText: '',
        errorScreenshot: false,
      };
    }
  }

  // Download image from URL (Teams attachments need Bearer token)
  private async downloadImage(url: string, authToken?: string): Promise<string | null> {
    try {
      const headers: Record<string, string> = {};
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }

      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        headers,
        timeout: 15000,
        maxContentLength: 10 * 1024 * 1024, // 10MB max
      });

      return Buffer.from(response.data).toString('base64');
    } catch (err) {
      logger.error(`[Vision] Failed to download image from ${url}`, err);
      return null;
    }
  }
}
