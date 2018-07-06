import { compile as jsonSchemaToTypescript} from 'json-schema-to-typescript';
import { lstatSync, existsSync, writeFile, mkdirSync, readFileSync } from 'fs';
import { resolve, join, basename } from 'path';
import { camelCase, upperFirst, size } from 'lodash'
import * as Ajv from 'ajv';
import { JSONSchema4 } from 'json-schema';
import { Options as PrettierOptions } from 'prettier';
import { Options as AjvOptions } from 'ajv';
import { format as prettify } from 'prettier';
const pack = require('ajv-pack');
const validatorFilePostfix = '.validate.js';

export interface Options {
  style?: PrettierOptions;
  ajvOptions?: AjvOptions;
  decoderName?: string;
  pack?: boolean;
}

export async function generateFromFile(
  inputFile: string,
  outputFolder: string,
  options?: Options,
) {
  if (!existsSync(inputFile)) {
    throw new Error(`Input schema file ${inputFile} not found`);
  }

  const schema = require(resolve(inputFile));

  return generate(schema, outputFolder, options);
}

function writeFilePromise(file: string, data: string) {
  return new Promise(function (resolve, reject) {
    const buffer = new Buffer(data, 'UTF-8');
    if (existsSync(file)) {
      // Compare the contents of the file before writing
      // We only write the file when the contents has changed to prevent compile events
      // when running the typescript compiler in watch mode
      var existingFile = readFileSync(file);
      if (existingFile.equals(buffer)) {
        // The contents is the same, do not write the file and resolve the promise
        resolve(data);
        return;
      }
    }
    
    writeFile(file, data, function (err) {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

export async function generate(
  schema: JSONSchema4,
  outputFolder: string,
  options?: Options,
) {
  schema = { definitions: schema.definitions };
  options = options || {};
  options.pack = options.pack === undefined ? true : options.pack;

  if (!existsSync(outputFolder)) {
    mkdirSync(outputFolder);
  }

  if (!lstatSync(outputFolder).isDirectory()) {
    throw new Error(`Output folder ${outputFolder} should be a directory`);
  }

  if (!schema.definitions || size(schema.definitions) === 0) {
    throw new Error(`No definitions found`);
  }

  const ajv = new Ajv({ 
    ...options.ajvOptions, 
    sourceCode: true, 
    async: false,
  });

  ajv.addSchema(schema, 'schema');

  const writeFiles: Array<Promise<any>> = [];
  let imports: string[] = [];
  let decoders: string[] = [];

  // Loop through all the definitions and generate the corresponding code
  for (const definitionKey of Object.keys(schema.definitions)) {
    const definition = schema.definitions[definitionKey];

    // Generate safe name (hopefullly matching that of json-schema-to-typescript)
    const name = toSafeString(definition.title || definitionKey);

    const validate = ajv.getSchema(`schema#/definitions/${definitionKey}`);


    // Write code of definition to single file
    if (options.pack) {
      const validatorFileName = `${name}${validatorFilePostfix}`;
      imports.push(`import * as ${name}$validate from './${validatorFileName}'`);
      decoders.push(decoderPack(name));

      var moduleCode = pack(ajv, validate);
      writeFiles.push(writeFilePromise(join(outputFolder, validatorFileName), moduleCode));
    } else {
      decoders.push(decoderNoPack(name));
    }
  }

  await Promise.all(writeFiles);

  // Generate the typescript models from the json schema
  const model = await jsonSchemaToTypescript(schema, 'GeneratedContainerSchema', { unreachableDefinitions: true, style: options.style});

  // Remove the empty container interface from the generated code 
  const cleanModel = model.replace(/export\s+interface\s+GeneratedContainerSchema\s+{[^\}]*\}/, '');

  const decoderName = options.decoderName || toSafeString(basename(outputFolder)) + 'Decoder';

  // Generate the code including the fromJson methods
  let code: string;
  if (options.pack === true) {
    code = templatePack(cleanModel, imports.join('\n'), decoders.join('\n'), decoderName);
  } else {
    code = templateNoPack(cleanModel, decoders.join('\n'), decoderName, schema, options.ajvOptions);
  }

  // Prettify the generated code
  const prettyCode = prettify(code, { parser: 'typescript', ...options.style })

  // Write the code to the output folder
  await writeFilePromise(join(outputFolder, 'index.ts'), prettyCode);
}

function toSafeString(string: string) {
  return upperFirst(camelCase(string))
}

function decoderPack(name: string) {
  return `static ${name} = decode<${name}>(${name}$validate, '${name}');`;
}

function decoderNoPack(name: string) {
  return `static ${name} = decode<${name}>('${name}');`;
}

function templateNoPack(models: string, decoders: string, decoderName: string, schema: JSONSchema4, ajvOptions?: AjvOptions) {
  return `
/* tslint:disable */
import * as Ajv from 'ajv';

${models}

let ajv: Ajv.Ajv;

function lazyAjv() {
  if (!ajv) {
    ajv = new Ajv(${JSON.stringify(ajvOptions || {})});
    ajv.addSchema(schema, 'schema');
  }

  return ajv;
}

const schema = ${JSON.stringify(schema)};
function decode<T>(dataPath: string): (json: any) => T {
  let validator: Ajv.ValidateFunction;
  return (json: any) => {
    if (!validator) {
      validator = lazyAjv().getSchema(\`schema#/definitions/\${dataPath}\`);
    }

    if (!validator(json)) {
      const errors = validator.errors || [];
      const errorMessage = errors.map(error => \`\${error.dataPath} \${error.message}\`.trim()).join(', ') || 'unknown';
      throw new ${decoderName}Error(\`Error validating \${dataPath}: \${errorMessage}\`, json);
    }
  
    return json as T;
  }
}
${decoder(decoders, decoderName)}`;
}

function templatePack(models: string, imports: string, decoders: string, decoderName: string) {
  return `
/* tslint:disable */
${imports}

${models}

function decode<T>(validator: (json: any) => boolean, dataPath: string): (json: any) => T {
  return (json: any) => {
    if (!validator(json)) {
      const errors: any[] = ((validator as any).errors as any) || [];
      const errorMessage = errors.map(error => \`\${error.dataPath} \${error.message}\`.trim()).join(', ') || 'unknown';
      throw new ${decoderName}Error(\`Error validating \${dataPath}: \${errorMessage}\`, json);
    }
  
    return json as T;
  }
}

${decoder(decoders, decoderName)}`;
}

function decoder(decoders: string, decoderName: string) {
  return `
export class ${decoderName}Error extends Error {
  readonly json: any;

  constructor(message: string, json: any) {
    super(message);
    this.json = json;
  }
}

export class ${decoderName} {
  ${decoders}
}
`;
}