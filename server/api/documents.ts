import { Router } from 'express';
import { storage } from '../storage';
import { documentProcessor } from '../services/documentProcessor';
import { supabaseStorage } from '../services/supabaseStorage';
import { insertDocumentSchema } from '../../shared/schema';

const router = Router();

// GET /api/documents - Get all documents
router.get('/', async (req, res) => {
  try {
    const documents = await storage.getAllDocuments();
    
    const formattedDocuments = documents.map((doc, index) => {
      return {
        [`Document ${doc.id}`]: {
          ID: doc.id,
          Name: doc.name,
          "File Type": doc.fileType,
          "Template ID": doc.templateId,
          "Creation Date": new Date(doc.createdAt).toDateString(),
          "Creation Time": new Date(doc.createdAt).toTimeString().split(' ')[0],
          "Download Endpoint": `/api/documents/${doc.id}/download`,
          "View URL": doc.storageUrl,
          "Placeholder Data": doc.placeholderData
        }
      };
    });

    const response = {
      "API Status": "Success",
      "Total Documents": documents.length,
      "Documents": Object.assign({}, ...formattedDocuments)
    };

    res.json(response);
  } catch (error) {
    console.error('Error fetching documents:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch documents' 
    });
  }
});

// GET /api/documents/:id - Get specific document
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const document = await storage.getDocument(id);
    
    if (!document) {
      return res.status(404).json({ 
        success: false,
        error: 'Document not found' 
      });
    }
    
    res.json({
      success: true,
      document: {
        id: document.id,
        name: document.name,
        fileType: document.fileType,
        templateId: document.templateId,
        createdDate: document.createdAt,
        downloadUrl: `/api/documents/${document.id}/download`,
        viewUrl: document.storageUrl,
        placeholderData: document.placeholderData
      }
    });
  } catch (error) {
    console.error('Error fetching document:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch document' 
    });
  }
});

// POST /api/documents/generate - Generate document from template
router.post('/generate', async (req, res) => {
  try {
    const { templateId, placeholderData, outputFormat = 'original' } = req.body;
    
    if (!templateId || !placeholderData) {
      return res.status(400).json({ error: 'Template ID and placeholder data are required' });
    }

    // Get template
    const template = await storage.getTemplate(templateId);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    // Download template file - extract filename from storage URL
    const urlParts = template.storageUrl.split('/');
    const fileName = decodeURIComponent(urlParts[urlParts.length - 1]);
    console.log(`Downloading template file: ${fileName}`);
    const templateBuffer = await supabaseStorage.downloadFile('templates', fileName);
    
    // Process the template with placeholder data
    let processedResult;
    if (template.fileType === 'docx') {
      processedResult = await documentProcessor.processDocxTemplate(templateBuffer, placeholderData);
    } else {
      processedResult = await documentProcessor.processExcelTemplate(templateBuffer, placeholderData);
    }

    let finalBuffer = processedResult.processedBuffer;
    let finalFileType = template.fileType;
    let finalFileName = processedResult.filename;

    // Convert to PDF if requested
    if (outputFormat === 'pdf') {
      const pdfResult = await documentProcessor.convertToPdf(finalBuffer, template.fileType as 'docx' | 'excel');
      finalBuffer = pdfResult.processedBuffer;
      finalFileType = 'pdf';
      finalFileName = pdfResult.filename;
    }

    // Upload processed document to storage
    const storageFile = await supabaseStorage.uploadFile(finalBuffer, 'generated-docs', finalFileName);

    // Save document metadata to database
    const documentData = {
      templateId: template.id,
      name: finalFileName,
      fileType: finalFileType,
      storageUrl: storageFile.url,
      storageId: storageFile.id,
      placeholderData
    };

    const document = await storage.createDocument(documentData);
    
    res.json({
      document,
      downloadUrl: storageFile.url,
      storageFile
    });
  } catch (error) {
    console.error('Error generating document:', error);
    res.status(500).json({ error: 'Failed to generate document' });
  }
});

// GET /api/documents/:id/download - Download document file
router.get('/:id/download', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const document = await storage.getDocument(id);
    
    if (!document) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // For downloads, regenerate the document on-demand to bypass storage permission issues
    try {
      // Get the template
      const template = await storage.getTemplate(document.templateId);
      if (!template) {
        return res.status(404).json({ error: 'Template not found' });
      }

      // Download template file - extract filename from storage URL
      const urlParts = template.storageUrl.split('/');
      const templateFileName = decodeURIComponent(urlParts[urlParts.length - 1]);
      const templateBuffer = await supabaseStorage.downloadFile('templates', templateFileName);
      
      // Process the template with saved placeholder data
      let processedResult;
      if (template.fileType === 'docx') {
        processedResult = await documentProcessor.processDocxTemplate(templateBuffer, document.placeholderData as Record<string, string>);
      } else if (template.fileType === 'excel') {
        processedResult = await documentProcessor.processExcelTemplate(templateBuffer, document.placeholderData as Record<string, string>);
      } else {
        return res.status(400).json({ error: 'Unsupported template file type' });
      }

      // Convert to PDF if needed
      if (document.fileType === 'pdf') {
        const pdfResult = await documentProcessor.convertToPdf(processedResult.processedBuffer, template.fileType as 'docx' | 'excel');
        processedResult = pdfResult;
      }

      // Serve the file directly
      let contentType = 'application/octet-stream';
      if (document.fileType === 'docx') {
        contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      } else if (document.fileType === 'excel') {
        contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      } else if (document.fileType === 'pdf') {
        contentType = 'application/pdf';
      }
      
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${document.name}"`);
      res.send(processedResult.processedBuffer);
    } catch (downloadError) {
      console.error('Failed to regenerate document for download:', downloadError);
      return res.status(500).json({ error: 'Failed to generate download file' });
    }
  } catch (error) {
    console.error('Error downloading document:', error);
    res.status(500).json({ error: 'Failed to download document' });
  }
});

// GET /api/templates/:templateId/documents - Get documents by template
router.get('/template/:templateId', async (req, res) => {
  try {
    const templateId = parseInt(req.params.templateId);
    const documents = await storage.getDocumentsByTemplate(templateId);
    
    const formattedDocuments = documents.map(doc => ({
      id: doc.id,
      name: doc.name,
      fileType: doc.fileType,
      createdDate: doc.createdAt,
      downloadUrl: `/api/documents/${doc.id}/download`,
      viewUrl: doc.storageUrl,
      placeholderData: doc.placeholderData
    }));

    res.json({
      success: true,
      templateId: templateId,
      count: formattedDocuments.length,
      documents: formattedDocuments
    });
  } catch (error) {
    console.error('Error fetching documents by template:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch documents' 
    });
  }
});

export default router;