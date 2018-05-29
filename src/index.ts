import { compile as jsonSchemaToTypescript} from 'json-schema-to-typescript';
import { lstatSync, existsSync, writeFile, mkdirSync } from 'fs';
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
}

export async function generateFromFile(
  inputFile: string,
  outputFolder: string,
  userOptions?: Options,
) {
  if (!existsSync(inputFile)) {
    throw new Error(`Input schema file ${inputFile} not found`);
  }

  const schema = require(resolve(inputFile));

  return generate(schema, outputFolder, userOptions);
}

function writeFilePromise(file: string, data: string) {
  return new Promise(function (resolve, reject) {
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

    const validatorFileName = `${name}${validatorFilePostfix}`;
    imports.push(`import * as ${name}$validate from './${validatorFileName}'`);
    decoders.push(decoder(name));

    var moduleCode = pack(ajv, validate);

    // Write code of definition to single file
    writeFiles.push(writeFilePromise(join(outputFolder, validatorFileName), moduleCode));
  }

  await Promise.all(writeFiles);

  // Generate the typescript models from the json schema
  const model = await jsonSchemaToTypescript(schema, 'GeneratedContainerSchema', { unreachableDefinitions: true, style: options.style});

  // Remove the empty container interface from the generated code 
  const cleanModel = model.replace(/export\s+interface\s+GeneratedContainerSchema\s+{[^\}]*\}/, '');

  const decoderName = options.decoderName || toSafeString(basename(outputFolder)) + 'Decoder';

  // Generate the code including the fromJson methods
  const code = template(cleanModel, imports.join('\n'), decoders.join('\n'), decoderName);

  // Prettify the generated code
  const prettyCode = prettify(code, { parser: 'typescript', ...options.style })

  // Write the code to the output folder
  await writeFilePromise(join(outputFolder, 'index.ts'), prettyCode);
}

function toSafeString(string: string) {
  return upperFirst(camelCase(string))
}

function decoder(name: string) {
  return `static ${name} = decode<${name}>(${name}$validate, '${name}');`;
}

function template(models: string, imports: string, decoders: string, decoderName: string) {
  return `
/* tslint:disable */
${imports}

${models}

function decode<T>(validator: (json: any) => boolean, dataPath: string): (json: any) => T {
  return (json: any) => {
    if (!validator(json)) {
      const errors: any[] = ((validator as any).errors as any) || [];
      const errorMessage = errors.map(error => error.dataPath + ' ' + error.message).join(', ') || 'unknown';
      throw new Error('Error validating ' + dataPath + ': ' + errorMessage);
    }
  
    return json as T;
  }
}

export class ${decoderName} {
  ${decoders}
}
`;
}
