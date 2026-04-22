# Object Storage Cost Considerations

## MinIO
- MinIO is an open-source, self-hosted object storage server that implements the S3 API and is licensed under AGPLv3.
- The community edition is free to download and run, so there are no licensing fees for the software itself.
- You are responsible for provisioning and maintaining the infrastructure (servers, disks, networking, backups, monitoring). Hardware, electricity, and staff time are ongoing costs even though the software is free.
- Optional commercial support and the MinIO Subscription Network (SUBNET) are paid offerings if you want enterprise support agreements.

## Other Options
- Managed cloud object stores such as Amazon S3, Azure Blob Storage, Google Cloud Storage, Backblaze B2, and Wasabi charge on a pay-as-you-go basis for capacity, requests, and data egress. These services remove the operational burden but introduce recurring fees.
- Hybrid approaches combine on-premises MinIO for hot data with cloud buckets for archival storage, balancing control and cost.

## Choosing Between Self-Hosted and Managed Storage
- **Budget model:** Self-hosted solutions trade license fees for capital expenditure (hardware) and operational expenditure (maintenance). Managed services are purely operational expense.
- **Operational expertise:** Running MinIO requires DevOps expertise for scaling, updates, and high availability. Managed services offload this responsibility to the provider.
- **Compliance & residency:** Self-hosting lets you control data locality. Cloud providers offer region selection and compliance certifications but may not meet strict air-gap requirements.

In short, MinIO’s software is free, but the total cost of ownership includes the infrastructure and effort needed to operate it reliably.
